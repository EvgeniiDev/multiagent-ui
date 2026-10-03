#!/usr/bin/env node
// deploy/execution/env-controller.mjs — trusted environment controller (F1).
//
// The ONLY service holding the Docker socket. Listens on a unix socket under
// the environment root; every request carries the channel token. Everything
// it does is constrained by the deployment config (environment.config.json):
// registered resource roots only, pinned images only, fixed role profiles,
// declared exec templates, declared egress. A client payload can supply
// names/ids and JSON materials — never absolute host paths, images, mounts,
// argv templates, or egress destinations.
//
// Owns:
//   * worker lifecycle — per-attempt container on its own internal network,
//     ro rootfs, non-root, dropped caps, no privileged/pid/host modes;
//   * worker materials — scoped pi creds (per-profile provider subset), ro
//     conf dir (prompt/porch-config/profile-flags/porch snapshot), own HOME
//     + attempt dirs, project snapshot (git tree export) or private repo,
//     role inputs, dep-set mount;
//   * canonical worktrees (controller-owned clone + task branch) and the
//     private→canonical full-result import;
//   * dep-set preparation (approved setup argv from config, lockfile-bound);
//   * the worker registry, persisted before any container mutation so a
//     restart restores live workers and never recreates vanished ones.
//
// Import-safe pattern is NOT used here — this file is the daemon entrypoint.

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, readFileSync, readlinkSync } from 'node:fs';
import {
  RuntimeError, spawnBounded, atomicWriteJson, ensureDir,
  assertSafeId, normPath, tailOf,
} from '../../server/execution/common.mjs';
import { loadEnvironmentConfigSync } from '../../server/execution/environment/env-config.mjs';
import {
  validateAgentProfile, profileFlags, scopedAgentSpec, porchAgentEntry,
  profileDigest, usesDuckDuckGoTransport,
} from '../../server/execution/environment/agent-profile.mjs';
import { createDockerApi } from './docker-api.mjs';
import { gitArchiveExtract, extractTarBuffer } from './tarx.mjs';
import { safeGit } from '../../server/execution/orchestrator/safe-git.mjs';
import { duckDuckGoExtensionSource } from './duckduckgo-transport.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/;
const WORKER_ID_RE = /^w-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const CANON_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const INPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;    // basename only
const GIT_TIMEOUT = 120_000;

// ---------- small helpers ----------------------------------------------------

function log(...a) { process.stderr.write(`[env-controller] ${a.join(' ')}\n`); }

function procNs(ns) {
  try { return readlinkSync(`/proc/self/ns/${ns}`); } catch { return null; }
}
function bootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return null; }
}

function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

async function exists(p) { try { await fs.lstat(p); return true; } catch { return false; } }

// ---------- controller --------------------------------------------------------

export function createEnvController({ config, docker, hostExec = spawnBounded }) {
  const envSec = config.environment;
  const envRoot = config.pathFor('env');                    // controller view
  const envHost = config.roots.env.hostPath;                // bind sources
  const workersView = path.join(envRoot, 'workers');
  const workersHost = path.join(envHost, 'workers');
  const canonView = path.join(envRoot, 'canonical');
  const canonHost = path.join(envHost, 'canonical');
  const depView = path.join(envRoot, 'depsets');
  const depHost = path.join(envHost, 'depsets');
  const registryFile = envSec.registryFile;

  const registry = { version: 1, workers: {}, canonicals: {}, depSets: {}, swarmSnapshots: {} };
  const operations = new Map();
  async function exclusive(key, work) {
    const prior = operations.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    operations.set(key, next);
    try { return await next; } finally { if (operations.get(key) === next) operations.delete(key); }
  }
  let registryLoaded = false;
  let gateway = { id: null, name: null };

  const identity = () => ({
    service: 'env-controller',
    hostname: os.hostname(),
    bootId: bootId(),
    pidNs: procNs('pid'),
    pid: process.pid,
    startedAt: startedAtIso,
    configDigest: configDigest,
  });
  const startedAtIso = new Date().toISOString();
  const configDigest = crypto.createHash('sha256')
    .update(JSON.stringify(sortKeys({
      roots: config.roots, images: config.images, roles: config.roles,
      egress: config.egress, execPolicy: {
        templates: config.execPolicy.templates.map((t) => t.name),
        envKeys: [...config.execPolicy.envKeys],
      }, setups: config.setups,
    }))).digest('hex');

  async function saveRegistry() {
    await ensureDir(path.dirname(registryFile));
    await atomicWriteJson(registryFile, registry, 0o600);
  }
  async function loadRegistry() {
    registryLoaded = true;
    let raw;
    try { raw = await fs.readFile(registryFile, 'utf8'); }
    catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      await saveRegistry();
      return;
    }
    const parsed = JSON.parse(raw);
    Object.assign(registry.workers, parsed.workers || {});
    Object.assign(registry.canonicals, parsed.canonicals || {});
    Object.assign(registry.depSets, parsed.depSets || {});
    Object.assign(registry.swarmSnapshots, parsed.swarmSnapshots || {});
  }

  async function git(cwd, args, { timeoutMs = GIT_TIMEOUT } = {}) {
    const res = await hostExec(['git', '-C', cwd, ...args],
      { timeoutMs, maxStdout: 4 * 1024 * 1024, maxStderr: 256 * 1024 });
    if (res.spawnError) {
      throw new RuntimeError('git_unavailable', `git spawn failed: ${res.spawnError}`);
    }
    return res;
  }

  async function gitStdout(cwd, args, code, what) {
    const res = await git(cwd, args);
    if (res.code !== 0) {
      throw new RuntimeError(code,
        `${what}: git ${args[0]} exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
    }
    return res.stdout.trim();
  }

  // Resolve a project name to a realpath inside the registered projects
  // root. The name is a single path segment — traversal is impossible.
  async function projectSource(projectRoot) {
    assertSafeId('projectRoot', projectRoot);
    const root = config.roots.projects.mountPath;
    const resolvedRoot = await fs.realpath(root);
    const p = path.join(root, projectRoot);
    const real = await fs.realpath(p).catch(() => null);
    if (!real || (real !== resolvedRoot && !real.startsWith(resolvedRoot + '/'))) {
      throw new RuntimeError('project_not_registered',
        `projectRoot ${projectRoot} does not resolve inside the projects root`);
    }
    return real;
  }

  async function verifyCommit(repoDir, sha) {
    if (!SHA_RE.test(sha || '')) {
      throw new RuntimeError('invalid_argument', `bad snapshot sha: ${sha}`);
    }
    const t = await gitStdout(repoDir, ['cat-file', '-t', sha],
      'snapshot_missing', 'snapshot sha is not an object');
    if (t !== 'commit') {
      throw new RuntimeError('snapshot_missing', `snapshot ${sha} is a ${t}, need commit`);
    }
    return sha;
  }

  // ---- gateway + networks ---------------------------------------------------

  async function findGateway() {
    if (gateway.id) return gateway;
    const list = await docker.containerList({
      label: [envSec.egressGateway.labelSelector],
    });
    const live = (list || []).find((c) => c.State === 'running' || c.State === 'created');
    if (!live) {
      throw new RuntimeError('gateway_unavailable',
        `no container labeled ${envSec.egressGateway.labelSelector} is running`);
    }
    gateway = { id: live.Id, name: (live.Names || [])[0] || live.Id };
    return gateway;
  }

  async function prepareWorkerNet(workerId) {
    const name = `${envSec.networkNamePrefix}${workerId}`.slice(0, 120);
    const labels = {
      [`${envSec.labelPrefix}`]: 'worker-net',
      [`${envSec.labelPrefix}.worker`]: workerId,
    };
    let net = await docker.networkInspect(name).catch(() => null);
    if (!net) {
      await docker.networkCreate({
        Name: name, Internal: true, Driver: 'bridge',
        Labels: labels,
        // Match the gateway bridge below the host tunnel's MTU (1420).
        Options: { 'com.docker.network.driver.mtu': '1400' },
      });
      net = await docker.networkInspect(name);
      if (!net) throw new RuntimeError('network_create_failed', `network ${name} not inspectable after create`);
    }
    const gw = await findGateway();
    await docker.networkConnect(net.Id, gw.id, [envSec.egressGateway.alias]);
    return { name, id: net.Id };
  }

  async function removeWorkerNet(netName) {
    // The gateway is attached to every worker net — detach it or the remove
    // fails with "active endpoints".
    const gw = await findGateway().catch(() => null);
    const net = await docker.networkInspect(netName).catch(() => null);
    if (net && gw?.id) {
      await docker.networkDisconnect(net.Id, gw.id).catch(() => {});
    }
    await docker.networkRemove(netName).catch(() => false);
  }

  async function tearDownWorker(rec) {
    if (rec.containerId) {
      await docker.containerRemove(rec.containerId, { force: true }).catch(() => {});
    }
    if (rec.netName) await removeWorkerNet(rec.netName);
  }

  // ---- worker materials ------------------------------------------------------

  async function writeConf(workerDir, { attemptId, profile, profileId, prompt, porchConfig }) {
    const conf = path.join(workerDir, 'conf');
    await ensureDir(conf);
    const synth = { agents: { [profileId]: porchAgentEntry(profile) } };
    if (porchConfig !== undefined && porchConfig !== null && !deepEqual(porchConfig, synth)) {
      throw new RuntimeError('porch_config_mismatch',
        'payload porchConfig does not match the profile-derived config');
    }
    await atomicWriteJson(path.join(conf, 'porch-config.json'), synth, 0o600);
    await atomicWriteJson(path.join(conf, 'profile-flags.json'),
      profileFlags(profile, { extRoot: '/work/node_modules', skillRoot: '/work/skills' }), 0o600);
    if (usesDuckDuckGoTransport(profile)) {
      await fs.copyFile(new URL('./duckduckgo-transport.mjs', import.meta.url), path.join(conf, 'duckduckgo-transport.mjs'));
      await fs.writeFile(path.join(conf, 'duckduckgo-extension.ts'), duckDuckGoExtensionSource(), { mode:0o600 });
    }
    await fs.writeFile(path.join(conf, 'prompt.md'), prompt, { mode: 0o600 });
    // Per-worker porch snapshot — copied under the ro conf mount so the
    // running worker can never mutate its own harness mid-run.
    const skillSrc = config.roots.porchSkill.mountPath;
    const dst = path.join(conf, 'porch');
    await fs.cp(skillSrc, dst, { recursive: true, force: false });
    const porchBin = path.join(dst, 'scripts', 'porch');
    if (!(await exists(porchBin))) {
      throw new RuntimeError('porch_missing', 'porch entrypoint absent from skill snapshot');
    }
    await fs.chmod(porchBin, 0o755).catch(() => {});
    return conf;
  }

  async function writeAgentDir(workerDir, profile) {
    const agentDir = path.join(workerDir, 'agent');
    await ensureDir(agentDir);
    const credsRoot = config.roots.piCreds.mountPath;
    let sourceModels;
    try {
      sourceModels = JSON.parse(await fs.readFile(path.join(credsRoot, 'models.json'), 'utf8'));
    } catch (e) {
      throw new RuntimeError('creds_source_unreadable',
        `cannot read credential source models.json: ${e.code || e.message}`);
    }
    const files = scopedAgentSpec(profile, sourceModels,
      { searchProxy: envSec.egressGateway.proxyUrl });
    for (const [name, doc] of Object.entries(files)) {
      await atomicWriteJson(path.join(agentDir, name), doc, 0o600);
    }
    // auth.json subset — only entries for this provider.
    try {
      const auth = JSON.parse(await fs.readFile(path.join(credsRoot, 'auth.json'), 'utf8'));
      const subset = {};
      for (const [k, v] of Object.entries(auth || {})) {
        if (k === profile.provider || k.startsWith(`${profile.provider}-`)) subset[k] = v;
      }
      if (Object.keys(subset).length) {
        await atomicWriteJson(path.join(agentDir, 'auth.json'), subset, 0o600);
      }
    } catch { /* auth.json optional */ }
    return agentDir;
  }

  async function writeInputs(workerDir, roleSpec, inputs) {
    const dir = path.join(workerDir, 'inputs');
    await ensureDir(dir);
    const allowed = new Set(['task', ...roleSpec.inputs]);
    for (const inp of inputs || []) {
      if (!INPUT_RE.test(inp?.name || '') || inp.name.includes('/')) {
        throw new RuntimeError('invalid_argument', `bad input name: ${inp?.name}`);
      }
      if (!allowed.has(inp.name)) {
        throw new RuntimeError('input_not_declared',
          `input ${inp.name} not declared for role ${roleSpec.name}`);
      }
      const content = typeof inp.content === 'string' ? inp.content : null;
      if (content === null || Buffer.byteLength(content) > envSec.maxInputBytes) {
        throw new RuntimeError('invalid_argument', `input ${inp.name} missing/oversized`);
      }
      await fs.writeFile(path.join(dir, inp.name), content, { mode: 0o600 });
    }
    return dir;
  }

  async function buildProject(workerDir, roleSpec, materials, workerId, canonical = null) {
    const projectDir = path.join(workerDir, 'project');
    await ensureDir(projectDir);
    if (roleSpec.projectMode === 'none') return { mode: 'none' };
    const fromCanonical = roleSpec.projectMode === 'private-repo' && materials.fromCanonical === true;
    let src;
    if (fromCanonical) {
      canonical = await registeredCanonical(materials.canonicalId);
      if (canonical.projectRoot !== materials.projectRoot || materials.snapshotId !== undefined) {
        throw new RuntimeError('canonical_binding_mismatch', 'fromCanonical source must match its registered project binding');
      }
      src = canonical.worktree;
      const currentHead = await gitStdout(src, ['rev-parse', 'HEAD'], 'canonical_read_failed', 'canonical HEAD');
      if (materials.snapshotSha !== currentHead) {
        throw new RuntimeError('canonical_binding_mismatch', 'fromCanonical snapshotSha must equal current registered canonical HEAD');
      }
      const dirty = await gitStdout(src, ['status', '--porcelain', '--untracked-files=all'], 'canonical_read_failed', 'canonical status');
      if (dirty) throw new RuntimeError('canonical_dirty', 'fromCanonical requires a clean committed canonical tree');
    } else if (materials.snapshotId !== undefined) {
      const snapshot = registry.swarmSnapshots[materials.snapshotId];
      if (!snapshot || snapshot.state !== 'ready'
        || snapshot.projectRoot !== materials.projectRoot || snapshot.snapshotSha !== materials.snapshotSha) {
        throw new RuntimeError('snapshot_binding_mismatch', 'snapshot materials do not match a registered immutable snapshot');
      }
      src = await fs.realpath(snapshot.repoGit);
      const snapshotRoot = await fs.realpath(path.join(envRoot, 'snapshots'));
      if (!src.startsWith(snapshotRoot + '/')) throw new RuntimeError('snapshot_binding_mismatch', 'snapshot source escaped registered root');
    } else {
      src = await projectSource(materials.projectRoot);
    }
    const sha = await verifyCommit(src, materials.snapshotSha);
    if (roleSpec.projectMode === 'snapshot-ro' || roleSpec.projectMode === 'workdir-rw') {
      await gitArchiveExtract(src, sha, projectDir);
      if (await exists(path.join(projectDir, '.git'))) {
        throw new RuntimeError('snapshot_dirty', 'exported tree contains a .git entry');
      }
      return { mode: roleSpec.projectMode, projectRoot: materials.projectRoot, sha, source: src };
    }
    if (roleSpec.projectMode === 'private-repo') {
      // Autonomous git-dir: snapshot tree imported as a single commit —
      // no alternates, no hardlinks, no remotes, no foreign refs.
      // fromCanonical: the F3 fix round builds the private repo from the
      // CANONICAL worktree's HEAD (which carries the prior import), never
      // from the pristine snapshot — otherwise fixes would lose prior work.
      const srcTreeSha = await gitStdout(src, ['rev-parse', `${sha}^{tree}`],
        'repo_init_failed', 'source tree');
      // The verified SHA pins the copied bytes even if canonical HEAD
      // advances after this admission decision.
      await gitArchiveExtract(src, sha, projectDir);
      await gitStdout(projectDir, ['init', '-q', '-b', 'task'], 'repo_init_failed', 'git init');
      const add = await git(projectDir, ['add', '-A']);
      if (add.code !== 0) throw new RuntimeError('repo_init_failed', `git add: ${add.stderr.slice(0, 300)}`);
      const ci = await git(projectDir,
        ['-c', 'user.email=f1-worker@local', '-c', 'user.name=f1-worker',
          'commit', '-qm', fromCanonical ? `canonical ${sha}` : `snapshot ${sha}`]);
      if (ci.code !== 0) throw new RuntimeError('repo_init_failed', `git commit: ${ci.stderr.slice(0, 300)}`);
      const head = await gitStdout(projectDir, ['rev-parse', 'HEAD'], 'repo_init_failed', 'verify HEAD');
      const headTree = await gitStdout(projectDir, ['rev-parse', 'HEAD^{tree}'], 'repo_init_failed', 'verify tree');
      if (headTree !== srcTreeSha) {
        throw new RuntimeError('repo_init_mismatch',
          `private repo tree ${headTree} != ${fromCanonical ? 'canonical' : 'snapshot'} tree ${srcTreeSha}`);
      }
      const remotes = await gitStdout(projectDir, ['remote'], 'repo_init_failed', 'remote list');
      if (remotes) throw new RuntimeError('repo_init_dirty', 'private repo has remotes');
      return { mode: 'private-repo', projectRoot: materials.projectRoot, sha, head, fromCanonical };
    }
    throw new RuntimeError('invalid_argument', `unknown projectMode ${roleSpec.projectMode}`);
  }

  async function mountList(workerId, roleSpec, depSet, scratch = null) {
    const wh = path.join(workersHost, workerId);
    const binds = [
      [`${wh}/conf`, '/work/conf', 'ro'],
      [`${wh}/agent`, '/work/agent', 'rw'],
      [`${wh}/home`, '/work/home', 'rw'],
      [`${wh}/attempt`, '/work/attempt', 'rw'],
      [`${wh}/inputs`, '/work/inputs', 'ro'],
      // Mount as node_modules: extension deps resolve via node's ancestor
      // scan only when the packages live under a node_modules-named dir.
      [`${config.roots.piExt.hostPath}`, '/work/node_modules', 'ro'],
      [`${config.roots.piSkills.hostPath}`, '/work/skills', 'ro'],
    ];
    if (roleSpec.projectMode !== 'none') {
      binds.push([`${wh}/project`, '/work/project',
        roleSpec.projectMode === 'snapshot-ro' ? 'ro' : 'rw']);
    }
    if (scratch) binds.push([`${wh}/scratch`, '/work/scratch', 'rw']);
    if (depSet) {
      // Mounted where the setup declared the dep path inside the project.
      const target = depSet.depPath
        ? `/work/project/${depSet.depPath}`
        : '/work/deps';
      binds.push([`${depHost}/${depSet.id}`, target, 'ro']);
    }
    return binds;
  }

  function workerContainerSpec(workerId, rec, netName, binds) {
    const gw = envSec.egressGateway;
    return {
      Image: rec.imageRef,
      name: `${envSec.workerNamePrefix}${workerId}`,
      Hostname: `w-${workerId.slice(0, 20)}`,
      User: `${envSec.workerUid}:${envSec.workerGid}`,
      Cmd: ['sleep', 'infinity'],
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME=/work/home',
        'PI_CODING_AGENT_DIR=/work/agent',
        `HTTP_PROXY=${gw.proxyUrl}`,
        `HTTPS_PROXY=${gw.proxyUrl}`,
        `http_proxy=${gw.proxyUrl}`,
        `https_proxy=${gw.proxyUrl}`,
        'PI_PROFILE_FLAGS_FILE=/work/conf/profile-flags.json',
        'PORCH_BIN_PI=/opt/env/pi-rpc-boundary.mjs',
        'TERM=dumb', 'NO_COLOR=1',
      ],
      Labels: {
        [envSec.labelPrefix]: 'worker',
        [`${envSec.labelPrefix}.worker`]: workerId,
        [`${envSec.labelPrefix}.role`]: rec.role,
        [`${envSec.labelPrefix}.attempt`]: rec.attemptId || '',
      },
      HostConfig: {
        NetworkMode: netName,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Privileged: false,
        Init: true,
        PidsLimit: 512,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' },
        Binds: binds.map(([s, d, m]) => `${s}:${d}:${m}`),
        // No port bindings, no extra hosts, no dns overrides — the internal
        // per-worker net is the only interface.
        PublishAllPorts: false,
      },
      NetworkingConfig: { EndpointsConfig: { [netName]: {} } },
    };
  }

  // ---- RPC method implementations -------------------------------------------

  async function workerPrepare(p) {
    const workerId = p?.workerId;
    if (!WORKER_ID_RE.test(workerId || '')) {
      throw new RuntimeError('invalid_argument', `bad workerId: ${workerId}`);
    }
    const attemptId = assertSafeId('attemptId', p.attemptId);
    const role = p.role;
    const roleSpec = config.roles[role];
    if (!roleSpec) throw new RuntimeError('role_not_registered', `role ${role} not in config`);
    const profile = validateAgentProfile(p.profile);
    const profileId = p.profileId !== undefined && p.profileId !== null
      ? assertSafeId('profileId', p.profileId) : profile.profileId;
    const digest = p.profileDigest;
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new RuntimeError('invalid_argument', 'profileDigest must be sha256 hex');
    }
    // The controller owns digest truth — a client can't claim a digest that
    // does not equal the profile it shipped.
    if (profileDigest(profile) !== digest) {
      throw new RuntimeError('profile_digest_mismatch',
        'profileDigest does not match the effective profile');
    }
    if (typeof p.prompt !== 'string' || !p.prompt.length
      || Buffer.byteLength(p.prompt) > envSec.maxPromptBytes) {
      throw new RuntimeError('invalid_argument', 'prompt missing or oversized');
    }
    const image = config.images[profile.image];
    if (!image) {
      throw new RuntimeError('image_not_registered',
        `profile.image ${profile.image} not in config.images`);
    }
    const img = await docker.imageInspect(image.ref).catch((e) => {
      throw new RuntimeError('image_unavailable',
        `worker image ${image.ref} not inspectable: ${e.message}`);
    });
    if (image.digest && img.Id !== image.digest
      && !(img.RepoDigests || []).includes(`${image.ref.split('@')[0]}@${image.digest}`)) {
      throw new RuntimeError('image_digest_mismatch',
        `worker image ${image.ref} resolves to ${img.Id}, pinned ${image.digest}`);
    }

    const materials = p.materials || {};
    let scratch = null;
    if (materials.scratch !== undefined) {
      const requested = materials.scratch;
      if (!requested || typeof requested !== 'object' || Array.isArray(requested)
        || Object.keys(requested).some(k => !['id', 'mount'].includes(k))
        || requested.mount !== '/work/scratch') {
        throw new RuntimeError('invalid_scratch', 'scratch requires only a safe id and mount /work/scratch');
      }
      assertSafeId('scratch.id', requested.id);
      scratch = { id: requested.id, mount: '/work/scratch' };
    }
    const wv = path.join(workersView, workerId);
    const reg = registry.workers[workerId];
    if (reg) {
      // Idempotent re-prepare ONLY when the recorded container is live. An
      // inspect failure is NOT proof of absence — refuse without claiming
      // the container is gone (D14), so 'worker_terminal' stays truthful.
      const { state, inspectError } = await inspectWorker(reg);
      if (state === 'running' || state === 'paused') {
        if (!deepEqual(reg.scratch ?? null, scratch)) {
          throw new RuntimeError('scratch_binding_mismatch', 'existing worker scratch binding is immutable');
        }
        return { ok: true, worker: reg, existed: true, controller: identity() };
      }
      if (inspectError) {
        throw new RuntimeError('worker_inspect_failed',
          `worker ${workerId} container state unverifiable: ${inspectError?.message || inspectError}`);
      }
      throw new RuntimeError('worker_terminal',
        `worker ${workerId} exists in registry but its container is gone — `
        + 'a new worker needs a new workerId (attempt retry)');
    }

    let depSet = null;
    if (materials.depSetId) {
      const ds = registry.depSets[materials.depSetId];
      if (!ds || ds.state !== 'ready') {
        throw new RuntimeError('deps_not_prepared',
          `depSet ${materials.depSetId} is not materialized — run deps.prepare first`);
      }
      depSet = registry.depSets[materials.depSetId];
    }
    let canonical = null;
    if (roleSpec.canonical) {
      const cid = materials.canonicalId;
      if (!cid || !registry.canonicals[cid] || registry.canonicals[cid].state !== 'ready') {
        throw new RuntimeError('canonical_not_prepared',
          `integrator requires canonical.prepare first (canonicalId ${cid})`);
      }
      canonical = registry.canonicals[cid];
    }

    // --- build materials BEFORE any container mutation ---
    await ensureDir(wv);
    for (const d of ['conf', 'agent', 'home', 'attempt', 'attempt/steer',
      'attempt/out', 'attempt/pi-sessions', 'inputs', 'project']) {
      await ensureDir(path.join(wv, d));
    }
    if (scratch) {
      const scratchDir = path.join(wv, 'scratch');
      await ensureDir(scratchDir);
      if (await fs.realpath(scratchDir) !== scratchDir || await fs.realpath(wv) !== wv) {
        throw new RuntimeError('invalid_scratch', 'scratch must be an owned directory without symlink redirects');
      }
    }
    await writeConf(wv, {
      attemptId, profile, profileId,
      prompt: p.prompt, porchConfig: p.porchConfig,
    });
    await writeAgentDir(wv, profile);
    await writeInputs(wv, roleSpec, materials.inputs);
    const project = await buildProject(
      wv, roleSpec, { ...materials, snapshotSha: materials.snapshotSha }, workerId, canonical);
    // Docker can't create a mountpoint under the read-only project bind —
    // pre-create it inside the materialized project before container create.
    if (depSet?.depPath && roleSpec.projectMode !== 'none') {
      await ensureDir(path.join(wv, 'project', depSet.depPath));
    }
    const binds = await mountList(workerId, roleSpec, depSet, scratch);

    const rec = {
      schemaVersion: 1,
      workerId, attemptId, role,
      profileDigest: digest,
      profileId: profile.profileId,
      imageRef: image.ref,
      imageId: img.Id,
      imageDigestPinned: image.digest || null,
      createdAt: new Date().toISOString(),
      state: 'prepared',
      workerDir: wv,
      hostDir: path.join(workersHost, workerId),
      binds: binds.map(([source, target, mode]) => ({ source, target, mode })),
      containerName: `${envSec.workerNamePrefix}${workerId}`,
      netName: `${envSec.networkNamePrefix}${workerId}`.slice(0, 120),
      project,
      depSetId: depSet?.id ?? null,
      canonicalId: canonical?.id ?? registry.swarmSnapshots[materials.snapshotId]?.canonicalId ?? null,
      canonicalWorktree: canonical?.worktree ?? null,
      scratch, scratchDir: scratch ? path.join(wv, 'scratch') : null,
      frozen: false, freezeRequested: false, stopRequested: false,
      containerId: null,
      containerStartedAt: null,
      gone: false,
      profileId,
    };
    // Worker identity + materials are durable BEFORE the container exists —
    // a crash after create never yields an unregistered container.
    registry.workers[workerId] = rec;
    await saveRegistry();

    // --- network + container ---
    const net = await prepareWorkerNet(workerId);
    rec.netId = net.id;
    const spec = workerContainerSpec(workerId, rec, net.name, binds);
    const created = await docker.containerCreate(spec);
    rec.containerId = created.Id;
    await saveRegistry();
    await docker.containerStart(created.Id);
    const insp = await docker.containerInspect(created.Id);
    rec.containerStartedAt = insp?.State?.StartedAt || null;
    rec.state = insp?.State?.Running ? 'running' : 'start_failed';
    rec.cwdContainer = roleSpec.projectMode === 'none' ? '/work/home' : '/work/project';
    await saveRegistry();
    if (rec.state !== 'running') {
      throw new RuntimeError('worker_start_failed',
        `worker container did not reach running state: ${insp?.State?.Status}`);
    }
    // The worker's identity record also lives inside its own dir — the
    // runner-side runtime reads it for reconcile without an extra RPC.
    await atomicWriteJson(path.join(wv, 'worker.json'), rec, 0o600);
    return { ok: true, worker: rec, existed: false, controller: identity() };
  }

  // Docker inspect → worker state. ONLY exited/dead containers report
  // 'stopped': their pid namespace is down, which is what the F1 reaper's
  // probe skip rests on. Any other non-running state (created, restarting,
  // paused, removing, unknown shape) keeps its raw status so consumers
  // fail closed — the reaper defers on unrecognized states instead of
  // assuming the namespace is down. A null inspect (404) is 'gone'.
  function dockerWorkerState(insp) {
    if (!insp) return 'gone';
    if (insp.State?.Paused === true || insp.State?.Status === 'paused') return 'paused';
    if (insp.State?.Running === true) return 'running';
    const status = typeof insp.State?.Status === 'string' ? insp.State.Status.toLowerCase() : null;
    if (status === 'exited' || status === 'dead') return 'stopped';
    return status ?? 'unknown';
  }

  // Inspect a registered worker's container and classify the outcome into
  // three DISTINCT cases (D14 — confirmed absence vs inspection failure):
  //   confirmedGone — containerInspect succeeded and answered null. The
  //     docker-api layer returns null ONLY on HTTP 404, so this is the only
  //     result allowed to report 'gone' or persist the durable gone flag.
  //     A record that never carried a containerId counts as confirmed
  //     absent too: nothing exists to inspect or reap.
  //   inspectError — ANY non-404 failure: socket error, timeout, 5xx,
  //     malformed/unreadable body. Reports 'inspect_failed', which is NOT
  //     in the reaper's {running,stopped,gone} accept set, so consumers
  //     fail closed (worker_state_unknown → defer). Callers must never
  //     persist gone/stopped on account of an inspectError.
  //   otherwise — dockerWorkerState() of the real payload: 'running',
  //     'stopped' (exited|dead only), raw transitional status, or
  //     'unknown' for a missing/unreadable State.
  async function inspectWorker(rec) {
    if (!rec.containerId) {
      return { state: 'gone', confirmedGone: true, insp: null, inspectError: null };
    }
    let insp;
    try {
      insp = await docker.containerInspect(rec.containerId);
    } catch (e) {
      return { state: 'inspect_failed', confirmedGone: false, insp: null, inspectError: e };
    }
    return {
      state: dockerWorkerState(insp), confirmedGone: insp === null, insp, inspectError: null,
    };
  }

  // The ONLY writer of the durable gone flag — a caller may invoke this
  // exclusively after inspectWorker() reported confirmedGone. Never for an
  // inspect error, never for a transitional or non-running state.
  async function markGone(rec) {
    if (rec.state === 'gone') return;
    rec.state = 'gone'; rec.gone = true; rec.goneAt = new Date().toISOString();
    await saveRegistry();
  }

  async function workerStatus(p) {
    const workerId = p?.workerId;
    const rec = registry.workers[workerId];
    if (!rec) throw new RuntimeError('unknown_worker', `no such worker: ${workerId}`);
    const { state, confirmedGone, inspectError } = await inspectWorker(rec);
    if (confirmedGone) await markGone(rec);
    return {
      ok: true, workerId, state, frozen: state === 'paused',
      freezeRequested: rec.freezeRequested === true, stopRequested: rec.stopRequested === true,
      namespaceAlive: state === 'running' || state === 'paused',
      ...(inspectError
        ? { inspectError: String(inspectError?.message || inspectError).slice(0, 300) }
        : {}),
      containerId: rec.containerId, imageId: rec.imageId,
      startedAt: rec.containerStartedAt, role: rec.role,
      profileDigest: rec.profileDigest, attemptId: rec.attemptId,
      canonicalId: rec.canonicalId, depSetId: rec.depSetId,
      controller: identity(),
    };
  }

  async function workerList() {
    const out = [];
    for (const [wid, rec] of Object.entries(registry.workers)) {
      const { state } = await inspectWorker(rec);
      out.push({
        workerId: wid,
        state,
        registered: rec.state, role: rec.role, attemptId: rec.attemptId,
        profileDigest: rec.profileDigest, imageId: rec.imageId,
        containerId: rec.containerId, canonicalId: rec.canonicalId,
      });
    }
    return { ok: true, workers: out, controller: identity() };
  }

  async function workerFreeze(p) {
    const rec = registry.workers[p?.workerId];
    if (!rec) throw new RuntimeError('unknown_worker', `no such worker: ${p?.workerId}`);
    if (rec.stopRequested || rec.gone || ['stopped', 'removed', 'cancelled'].includes(rec.state)) {
      throw new RuntimeError('worker_terminal', 'cannot freeze a terminal worker');
    }
    const observed = await inspectWorker(rec);
    if (!['running', 'paused'].includes(observed.state)) {
      throw new RuntimeError('worker_not_running', `cannot freeze worker in state ${observed.state}`);
    }
    rec.freezeRequested = true;
    await saveRegistry();
    if (observed.state !== 'paused') await docker.containerPause(rec.containerId);
    const confirmed = await inspectWorker(rec);
    if (confirmed.state !== 'paused') throw new RuntimeError('worker_freeze_unconfirmed', 'Docker pause is not confirmed');
    rec.frozen = true; rec.state = 'paused';
    await saveRegistry();
    return { ok: true, workerId: rec.workerId, state: 'paused', frozen: true, controller: identity() };
  }

  async function workerThaw(p) {
    const rec = registry.workers[p?.workerId];
    if (!rec) throw new RuntimeError('unknown_worker', `no such worker: ${p?.workerId}`);
    if (rec.stopRequested || rec.gone || ['stopped', 'removed', 'cancelled'].includes(rec.state)) {
      throw new RuntimeError('worker_terminal', 'cannot thaw a terminal worker');
    }
    const observed = await inspectWorker(rec);
    if (!['running', 'paused'].includes(observed.state)) {
      throw new RuntimeError('worker_not_running', `cannot thaw worker in state ${observed.state}`);
    }
    rec.freezeRequested = false;
    await saveRegistry();
    if (observed.state === 'paused') await docker.containerUnpause(rec.containerId);
    const confirmed = await inspectWorker(rec);
    if (confirmed.state !== 'running') throw new RuntimeError('worker_thaw_unconfirmed', 'Docker unpause is not confirmed');
    rec.frozen = false; rec.state = 'running';
    await saveRegistry();
    return { ok: true, workerId: rec.workerId, state: 'running', frozen: false, controller: identity() };
  }

  async function workerStop(p) {
    const workerId = p?.workerId;
    const rec = registry.workers[workerId];
    if (!rec) throw new RuntimeError('unknown_worker', `no such worker: ${workerId}`);
    rec.stopRequested = true;
    await saveRegistry();
    const before = await inspectWorker(rec);
    if (before.state === 'paused') {
      // Never resume cancelled work just to stop it. Force-removing the
      // registered container drains its frozen namespace directly.
      await docker.containerRemove(rec.containerId, { force: true });
    } else if (before.state === 'running') {
      await docker.containerStop(rec.containerId, { timeoutS: p?.timeoutS ?? 5 })
        .catch((e) => { throw new RuntimeError('worker_stop_failed', e.message); });
    } else if (!['stopped', 'gone'].includes(before.state)) {
      throw new RuntimeError('worker_stop_unconfirmed', `cannot stop unverifiable worker (${before.state})`);
    }
    const confirmed = await inspectWorker(rec);
    if (!['stopped', 'gone'].includes(confirmed.state)) {
      throw new RuntimeError('worker_stop_unconfirmed', 'Docker did not confirm worker drainage');
    }
    rec.state = confirmed.state; rec.frozen = false; rec.freezeRequested = false;
    if (confirmed.confirmedGone) { rec.gone = true; rec.goneAt = new Date().toISOString(); }
    await saveRegistry();
    return { ok: true, workerId, state: confirmed.state, controller: identity() };
  }

  async function workerRemove(p) {
    const workerId = p?.workerId;
    const rec = registry.workers[workerId];
    if (!rec) throw new RuntimeError('unknown_worker', `no such worker: ${workerId}`);
    await tearDownWorker(rec);
    rec.state = 'removed';
    rec.removedAt = new Date().toISOString();
    await saveRegistry();
    return { ok: true, workerId, state: 'removed', controller: identity() };
  }

  // Exec gate: argv must match a declared template; every tail arg matching
  // the arg regex AND any absolute paths must stay under declared roots;
  // env keys ⊆ declared allowlist; cwd must be a declared cwdKey.
  function checkExec(workerId, spec) {
    const rec = registry.workers[workerId];
    if (!rec) throw new RuntimeError('unknown_worker', `no such worker: ${workerId}`);
    const tpl = config.execPolicy.templates.find((t) => t.name === spec.template);
    if (!tpl) throw new RuntimeError('exec_template_unknown', `no such exec template: ${spec.template}`);
    if (tpl.requiresFlag && envSec[tpl.requiresFlag] !== true) {
      throw new RuntimeError('exec_template_disabled',
        `template ${tpl.name} requires ${tpl.requiresFlag} in config`);
    }
    const args = spec.args || [];
    if (!Array.isArray(args) || args.length > tpl.maxArgs) {
      throw new RuntimeError('invalid_argument', `exec args bad (max ${tpl.maxArgs})`);
    }
    const argv = [...tpl.head, ...args];
    for (const a of args) {
      if (typeof a !== 'string' || !tpl.argRe.test(a)) {
        throw new RuntimeError('exec_arg_rejected', `exec arg rejected: ${a?.slice?.(0, 80)}`);
      }
      // Absolute paths may appear bare or after '='/--flag=value — every
      // absolute path embedded in an argument must stay under a declared
      // container root. Only enforced for templates that declare pathRoots;
      // free-form templates (debug shell) can't be path-tokenized sanely.
      let embedded = null;
      if (a.startsWith('/')) embedded = a;
      else if (a.includes('=/')) {
        embedded = a.slice(a.indexOf('=/') + 1).split(/[\s'"]/)[0];
      }
      if (embedded !== null && tpl.pathRoots.length) {
        const ok = tpl.pathRoots.some((r) => embedded === r || embedded.startsWith(r + '/'));
        if (!ok) {
          throw new RuntimeError('exec_arg_path_rejected',
            `exec arg path outside declared roots: ${a}`);
        }
      }
    }
    const cwdKey = spec.cwdKey || 'home';
    const cwd = config.execPolicy.cwdKeys[cwdKey];
    if (!cwd) throw new RuntimeError('invalid_argument', `unknown cwdKey ${cwdKey}`);
    const envObj = spec.env || {};
    const env = [];
    for (const [k, v] of Object.entries(envObj)) {
      if (!config.execPolicy.envKeys.has(k)) {
        throw new RuntimeError('exec_env_rejected', `env key not allowlisted: ${k}`);
      }
      const val = String(v);
      if (!/^[\x20-\x7e]{0,4096}$/.test(val)) {
        throw new RuntimeError('exec_env_rejected', `env ${k} has invalid value chars`);
      }
      // Env values that are absolute paths must stay inside the worker's
      // own writable/conf roots — an allowlisted key must not redirect a
      // PORCH dir onto foreign state.
      if (val.startsWith('/')) {
        const roots = ['/work/attempt', '/work/conf', '/work/node_modules',
          '/work/home', '/work/project', '/work/inputs', '/work/deps', '/tmp'];
        if (!roots.some((r) => val === r || val.startsWith(r + '/'))) {
          throw new RuntimeError('exec_env_rejected',
            `env ${k} path outside worker roots: ${val}`);
        }
      }
      env.push(`${k}=${val}`);
    }
    const timeoutMs = Math.min(
      Math.max(1000, spec.timeoutMs ?? 30_000), envSec.maxExecMs);
    const maxStdout = Math.min(Math.max(1024, spec.maxStdout ?? 256 * 1024), envSec.maxOutputBytes);
    const maxStderr = Math.min(Math.max(1024, spec.maxStderr ?? 256 * 1024), envSec.maxOutputBytes);
    return { rec, argv, cwd, env, timeoutMs, maxStdout, maxStderr };
  }

  async function execInWorker(workerId, argv, { cwd, env, timeoutMs, maxStdout, maxStderr }) {
    const rec = registry.workers[workerId];
    const { state, confirmedGone, inspectError } = await inspectWorker(rec);
    if (state !== 'running') {
      // Only CONFIRMED absence may durably mark the worker gone — an
      // inspect failure or a non-running/transitional docker state proves
      // nothing about the container's existence.
      if (confirmedGone) await markGone(rec);
      if (inspectError) {
        throw new RuntimeError('worker_inspect_failed',
          `worker ${workerId} container state unverifiable: ${inspectError?.message || inspectError}`);
      }
      throw new RuntimeError(confirmedGone ? 'worker_gone' : 'worker_not_running',
        `worker ${workerId} container is not running (docker state: ${state})`);
    }
    const execId = await docker.execCreate(rec.containerId, {
      AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false,
      Cmd: argv, Env: env, WorkingDir: cwd,
      User: `${envSec.workerUid}:${envSec.workerGid}`,
    });
    const res = await docker.execStart(execId, { timeoutMs, maxStdout, maxStderr });
    if (res.apiError) {
      return { ok: false, execId, error: { code: 'exec_start_failed', message: res.apiError } };
    }
    let exitCode = null;
    if (!res.timedOut) {
      const det = await docker.execInspect(execId).catch(() => null);
      exitCode = det?.ExitCode ?? null;
    }
    return {
      ok: true, execId, workerId,
      exitCode, timedOut: res.timedOut === true,
      stdout: res.stdout, stderr: res.stderr,
      stdoutTruncated: res.stdoutTruncated, stderrTruncated: res.stderrTruncated,
      durationMs: res.durationMs,
      controller: identity(),
    };
  }

  async function workerExec(p) {
    const checked = checkExec(p.workerId, p);
    return await execInWorker(p.workerId, checked.argv, checked);
  }

  // ---- canonical worktrees + import -----------------------------------------

  async function canonicalPrepare(p) {
    const cid = p?.canonicalId;
    if (!CANON_RE.test(cid || '')) {
      throw new RuntimeError('invalid_argument', `bad canonicalId: ${cid}`);
    }
    const existing = registry.canonicals[cid];
    if (existing?.state === 'ready') {
      return { ok: true, canonical: existing, existed: true, controller: identity() };
    }
    const src = await projectSource(p.projectRoot);
    const sha = await verifyCommit(src, p.baseSha || p.snapshotSha);
    const branch = p.branch || `acp/fusion/${cid}`;
    if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.startsWith('-')) {
      throw new RuntimeError('invalid_argument', `bad branch ${branch}`);
    }
    const dir = path.join(canonView, cid);
    const repoGit = path.join(dir, 'repo.git');
    const worktree = path.join(dir, 'worktree');
    await ensureDir(dir);
    // Autonomous clone: file:// forces real object copy — no hardlinks, no
    // alternates, no linkage to the source repo's mutable state.
    const cl = await hostExec(
      ['git', 'clone', '--bare', `file://${src}`, repoGit],
      { timeoutMs: 300_000, maxStdout: 1024 * 1024, maxStderr: 256 * 1024 });
    if (cl.code !== 0) {
      throw new RuntimeError('canonical_clone_failed',
        `git clone exited ${cl.code}: ${cl.stderr.slice(0, 300)}`);
    }
    const wt = await git(repoGit,
      ['worktree', 'add', worktree, '-b', branch, sha]);
    if (wt.code !== 0) {
      throw new RuntimeError('canonical_worktree_failed',
        `git worktree add exited ${wt.code}: ${wt.stderr.slice(0, 300)}`);
    }
    const head = await gitStdout(worktree, ['rev-parse', 'HEAD'],
      'canonical_verify_failed', 'canonical HEAD');
    if (head !== sha) {
      throw new RuntimeError('canonical_verify_failed', `worktree HEAD ${head} != ${sha}`);
    }
    const rec = {
      schemaVersion: 1, id: cid, projectRoot: p.projectRoot,
      baseSha: sha, branch, dir, hostDir: path.join(canonHost, cid),
      repoGit, worktree, state: 'ready',
      createdAt: new Date().toISOString(), imports: [],
    };
    registry.canonicals[cid] = rec;
    await saveRegistry();
    return { ok: true, canonical: rec, existed: false, controller: identity() };
  }

  async function canonicalStatus(p) {
    const cid = p?.canonicalId;
    const rec = registry.canonicals[cid];
    if (!rec) throw new RuntimeError('unknown_canonical', `no such canonical: ${cid}`);
    const head = await gitStdout(rec.worktree, ['rev-parse', 'HEAD'],
      'canonical_read_failed', 'canonical HEAD').catch(() => null);
    return { ok: true, canonical: { ...rec, head }, controller: identity() };
  }

  // Full-result import: every file state change in the worker's private repo
  // (committed AND uncommitted, new AND deleted) lands in the canonical
  // branch. Content moves as a git archive of the private index tree — no
  // object/references transfer, canonical never gains foreign refs.
  async function repoImport(p) {
    const workerId = p?.workerId;
    const wrec = registry.workers[workerId];
    if (!wrec) throw new RuntimeError('unknown_worker', `no such worker: ${workerId}`);
    // Canonical binding (not the role name) is the authority: prepare already
    // refused roles without canonical:true, so any worker carrying a
    // canonicalId was bound through a canonical-capable role.
    if (!wrec.canonicalId) {
      throw new RuntimeError('not_integrator', `worker ${workerId} has no canonical binding`);
    }
    const canon = registry.canonicals[wrec.canonicalId];
    if (!canon || canon.state !== 'ready') {
      throw new RuntimeError('canonical_not_ready', `canonical ${wrec.canonicalId} not ready`);
    }
    const priv = path.join(wrec.workerDir, 'project');
    // Stage the ENTIRE private worktree (add -A covers new+modified+deleted)
    // and materialize it as a tree — works for uncommitted leftovers too.
    const add = await safeGit(priv, ['add', '-A']);
    if (add.code !== 0) {
      throw new RuntimeError('import_stage_failed', `git add -A: ${add.stderr.slice(0, 300)}`);
    }
    const tree = await safeGit(priv, ['write-tree']);
    if (tree.code !== 0) throw new RuntimeError('import_tree_failed', tree.stderr.slice(0, 300));
    const treeSha = tree.stdout.trim();
    const archive = await safeGit(priv, ['archive', '--format=tar', treeSha], { binary: true, maxStdout: 512 * 1024 * 1024 });
    if (archive.code !== 0) throw new RuntimeError('import_archive_failed', archive.stderr.slice(0, 300));
    if (archive.stdout.length > 512 * 1024 * 1024) throw new RuntimeError('import_archive_too_large', 'Worker archive exceeds limit');
    const wt = canon.worktree;
    // Replace worktree content with exactly the tree: clear all entries
    // except .git, extract the archive, stage, commit.
    for (const e of await fs.readdir(wt)) {
      if (e === '.git') continue;
      await fs.rm(path.join(wt, e), { recursive: true, force: true });
    }
    await extractTarBuffer(archive.stdout, wt);
    const add2 = await git(wt, ['add', '-A']);
    if (add2.code !== 0) {
      throw new RuntimeError('import_commit_failed', `git add: ${add2.stderr.slice(0, 300)}`);
    }
    const headTree = await gitStdout(wt, ['rev-parse', 'HEAD^{tree}'],
      'import_commit_failed', 'canonical HEAD tree');
    let commitSha = await gitStdout(wt, ['rev-parse', 'HEAD'],
      'import_commit_failed', 'canonical HEAD');
    let changed = false;
    if (headTree !== treeSha) {
      const ci = await git(wt,
        ['-c', 'user.email=f1-controller@local', '-c', 'user.name=f1-controller',
          'commit', '-qm',
          `import worker ${workerId} attempt ${wrec.attemptId}`]);
      if (ci.code !== 0) {
        throw new RuntimeError('import_commit_failed',
          `git commit exited ${ci.code}: ${ci.stderr.slice(0, 300)}`);
      }
      commitSha = await gitStdout(wt, ['rev-parse', 'HEAD'], 'import_commit_failed', 'HEAD');
      changed = true;
    }
    // PROOF: the committed tree must equal the private index tree byte-exact.
    const finalTree = await gitStdout(wt, ['rev-parse', 'HEAD^{tree}'],
      'import_verify_failed', 'final tree');
    if (finalTree !== treeSha) {
      throw new RuntimeError('import_verify_failed',
        `canonical tree ${finalTree} != imported ${treeSha}`);
    }
    const diffStat = await gitStdout(wt,
      ['diff', '--stat', `${canon.baseSha}..HEAD`],
      'import_verify_failed', 'diffstat').catch(() => '');
    const imp = {
      at: new Date().toISOString(), workerId, attemptId: wrec.attemptId,
      treeSha, commitSha, changed, baseSha: canon.baseSha, diffStat,
    };
    canon.imports.push(imp);
    await saveRegistry();
    return { ok: true, import: imp, controller: identity() };
  }

  async function registeredCanonical(canonicalId) {
    if (!CANON_RE.test(canonicalId || '')) throw new RuntimeError('invalid_argument', 'invalid canonicalId');
    const rec = registry.canonicals[canonicalId];
    if (!rec || rec.state !== 'ready') throw new RuntimeError('canonical_not_prepared', 'canonical must be registered and ready');
    const root = await fs.realpath(canonView);
    const real = await fs.realpath(rec.worktree);
    if (!real.startsWith(root + '/') || real !== path.join(root, canonicalId, 'worktree')) {
      throw new RuntimeError('canonical_binding_mismatch', 'canonical path escaped registered binding');
    }
    return rec;
  }

  async function swarmSnapshot(p) {
    const canonical = await registeredCanonical(p.canonicalId);
    if (!Number.isSafeInteger(p.generation) || p.generation < 0) {
      throw new RuntimeError('invalid_argument', 'generation must be a nonnegative safe integer');
    }
    if (p.workspacePath !== undefined && p.workspacePath !== canonical.worktree
      && p.workspacePath !== path.join(canonical.hostDir, 'worktree')) {
      throw new RuntimeError('canonical_binding_mismatch', 'workspacePath must equal the registered canonical worktree');
    }
    for (const worker of Object.values(registry.workers)) {
      if (worker.role !== 'swarm-participant' || worker.canonicalId !== canonical.id) continue;
      const observed = await inspectWorker(worker);
      if (!['paused', 'stopped', 'gone'].includes(observed.state)) {
        throw new RuntimeError('snapshot_workers_unfrozen', `participant ${worker.workerId} has no physical pause/absence proof (${observed.state})`);
      }
    }
    // Git stages the actual full working tree with fixed argv. Participants
    // have already been physically frozen by the broker before this call.
    const added = await git(canonical.worktree, ['add', '-A']);
    if (added.code !== 0) throw new RuntimeError('snapshot_stage_failed', added.stderr.slice(0, 300));
    const treeSha = await gitStdout(canonical.worktree, ['write-tree'], 'snapshot_stage_failed', 'snapshot tree');
    const snapshotId = `ss-${crypto.createHash('sha256').update(`${canonical.id}:${p.generation}`).digest('hex').slice(0, 32)}`;
    const existing = registry.swarmSnapshots[snapshotId];
    if (existing) {
      if (existing.treeSha !== treeSha) throw new RuntimeError('snapshot_generation_conflict', 'generation is already bound to a different working tree');
      return snapshotResult(existing);
    }
    const previousTree = await gitStdout(canonical.worktree, ['rev-parse', 'HEAD^{tree}'], 'snapshot_commit_failed', 'canonical tree');
    if (treeSha !== previousTree) {
      const committed = await git(canonical.worktree, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
        '-c', 'user.email=acp-snapshot@local', '-c', 'user.name=acp-snapshot', 'commit', '-qm', `swarm generation ${p.generation}`]);
      if (committed.code !== 0) throw new RuntimeError('snapshot_commit_failed', committed.stderr.slice(0, 300));
    }
    const snapshotSha = await gitStdout(canonical.worktree, ['rev-parse', 'HEAD'], 'snapshot_commit_failed', 'snapshot HEAD');
    const repoGit = path.join(envRoot, 'snapshots', snapshotId, 'repo.git');
    await ensureDir(path.dirname(repoGit));
    // Isolated object copy pins the snapshot even after canonical imports.
    // A previous interrupted copy has no durable binding and can be rebuilt.
    await fs.rm(repoGit, { recursive: true, force: true });
    const clone = await hostExec(['git', 'clone', '--bare', `file://${canonical.worktree}`, repoGit],
      { timeoutMs: GIT_TIMEOUT, maxStdout: 1024 * 1024, maxStderr: 256 * 1024 });
    if (clone.code !== 0) throw new RuntimeError('snapshot_clone_failed', clone.stderr.slice(0, 300));
    await verifyCommit(repoGit, snapshotSha);
    const rec = { state: 'ready', snapshotId, canonicalId: canonical.id, generation: p.generation,
      projectRoot: canonical.projectRoot, snapshotSha, treeSha, repoGit, createdAt: new Date().toISOString() };
    registry.swarmSnapshots[snapshotId] = rec;
    await saveRegistry();
    return snapshotResult(rec);
  }

  function snapshotResult(rec) {
    return { ok: true, canonicalId: rec.canonicalId, generation: rec.generation,
      snapshotSha: rec.snapshotSha, treeSha: rec.treeSha,
      materials: { projectRoot: rec.projectRoot, snapshotSha: rec.snapshotSha, snapshotId: rec.snapshotId }, controller: identity() };
  }

  // ---- dep sets --------------------------------------------------------------

  async function depsPrepare(p) {
    if (Object.keys(p).some(k => !['setupId', 'projectRoot', 'snapshotSha', 'canonicalId'].includes(k))) {
      throw new RuntimeError('invalid_argument', 'dependency setup accepts registered binding fields only');
    }
    const setupId = p?.setupId;
    const setup = config.setups[setupId];
    if (!setup) throw new RuntimeError('setup_not_registered', `no such setup: ${setupId}`);
    let src, sha, projectRoot = p.projectRoot;
    if (p.canonicalId !== undefined) {
      const canonical = await registeredCanonical(p.canonicalId);
      src = canonical.worktree; projectRoot = canonical.projectRoot;
      const dirty = await gitStdout(src, ['status', '--porcelain'], 'canonical_read_failed', 'canonical status');
      if (dirty) throw new RuntimeError('canonical_dirty', 'snapshot canonical changes before preparing dependencies');
      sha = await gitStdout(src, ['rev-parse', 'HEAD'], 'canonical_read_failed', 'canonical HEAD');
      if ((p.projectRoot !== undefined && p.projectRoot !== projectRoot)
        || (p.snapshotSha !== undefined && p.snapshotSha !== sha)) {
        throw new RuntimeError('canonical_binding_mismatch', 'dependency source differs from registered canonical HEAD');
      }
    } else {
      src = await projectSource(projectRoot);
      sha = await verifyCommit(src, p.snapshotSha);
    }
    // Lockfile bytes AT the snapshot — the dep set binds to exactly these.
    const lockParts = [];
    for (const lf of setup.lockfiles) {
      const res = await git(src, ['show', `${sha}:${lf}`]);
      if (res.code !== 0) {
        throw new RuntimeError('lockfile_missing',
          `lockfile ${lf} absent at ${sha}: ${res.stderr.slice(0, 200)}`);
      }
      lockParts.push(lf, res.stdout);
    }
    const lockHash = crypto.createHash('sha256')
      .update(JSON.stringify(lockParts)).digest('hex');
    const image = config.images.worker;
    const depSetId = crypto.createHash('sha256')
      .update(JSON.stringify({
        setupId, lockHash, imageRef: image.ref,
        imageDigest: image.digest || null,
      })).digest('hex').slice(0, 32);
    const existing = registry.depSets[depSetId];
    if (existing?.state === 'ready') {
      return { ok: true, depSetId, cached: true, setupId, lockHash, snapshotSha: sha, canonicalId: p.canonicalId ?? null, controller: identity() };
    }
    // Materialize via a real setup worker — same constraints as a
    // participant worker plus a rw dep mount and the declared setup argv.
    const stagingName = `.staging-${depSetId}`;
    const stagingView = path.join(depView, stagingName);
    const stagingHost = path.join(depHost, stagingName);
    await fs.rm(stagingView, { recursive: true, force: true });
    await ensureDir(stagingView);

    const workerId = `w-deps-${depSetId.slice(0, 24)}`;
    const wv = path.join(workersView, workerId);
    // A dep worker id is derived from content hash — reuse is idempotent.
    const prior = registry.workers[workerId];
    if (prior?.containerId) {
      await tearDownWorker(prior);
      delete registry.workers[workerId];
      await saveRegistry();
    }
    await fs.rm(wv, { recursive: true, force: true });

    for (const d of ['conf', 'agent', 'home', 'attempt', 'inputs', 'project']) {
      await ensureDir(path.join(wv, d));
    }
    // Minimal conf (setup runs no porch): flags empty, porch not needed —
    // but keep the layout identical so the exec gate stays uniform.
    await atomicWriteJson(path.join(wv, 'conf', 'profile-flags.json'), [], 0o600);
    await atomicWriteJson(path.join(wv, 'conf', 'porch-config.json'), { agents: {} }, 0o600);
    await fs.writeFile(path.join(wv, 'conf', 'prompt.md'), '(setup worker — no prompt)', { mode: 0o600 });
    await gitArchiveExtract(src, sha, path.join(wv, 'project'));

    const depContainerPath = `/work/project/${setup.depPath}`;
    const binds = [
      [`${workersHost}/${workerId}/conf`, '/work/conf', 'ro'],
      [`${workersHost}/${workerId}/agent`, '/work/agent', 'rw'],
      [`${workersHost}/${workerId}/home`, '/work/home', 'rw'],
      [`${workersHost}/${workerId}/attempt`, '/work/attempt', 'rw'],
      [`${workersHost}/${workerId}/inputs`, '/work/inputs', 'ro'],
      [`${workersHost}/${workerId}/project`, '/work/project', 'rw'],
      // The dep output dir is mounted where the build system expects it —
      // e.g. /work/project/node_modules — so `npm ci` materializes into it.
      [stagingHost, depContainerPath, 'rw'],
    ];
    const rec = {
      schemaVersion: 1, workerId, attemptId: `deps-${depSetId}`,
      role: 'setup', profileDigest: `deps-${depSetId}`,
      profileId: 'setup', imageRef: image.ref,
      createdAt: new Date().toISOString(), state: 'prepared',
      workerDir: wv, hostDir: path.join(workersHost, workerId),
      binds: binds.map(([source, target, mode]) => ({ source, target, mode })),
      containerName: `${envSec.workerNamePrefix}${workerId}`,
      netName: `${envSec.networkNamePrefix}${workerId}`.slice(0, 120),
      project: { mode: 'setup', projectRoot, sha },
      depSetId, depPath: depContainerPath,
      containerId: null, gone: false,
    };
    const img = await docker.imageInspect(image.ref).catch((e) => {
      throw new RuntimeError('image_unavailable', `worker image: ${e.message}`);
    });
    rec.imageId = img.Id;
    registry.workers[workerId] = rec;
    await saveRegistry();
    const net = await prepareWorkerNet(workerId);
    rec.netId = net.id;
    const spec = workerContainerSpec(workerId, rec, net.name, binds);
    const created = await docker.containerCreate(spec);
    rec.containerId = created.Id;
    await saveRegistry();
    await docker.containerStart(created.Id);
    const insp = await docker.containerInspect(created.Id);
    if (!insp?.State?.Running) {
      rec.state = 'start_failed'; await saveRegistry();
      throw new RuntimeError('worker_start_failed', 'dep worker failed to start');
    }
    rec.state = 'running';
    await saveRegistry();

    // Run the APPROVED setup argv — declared in config, never from payload.
    let res;
    try {
      res = await execInWorker(workerId, setup.argv, {
        cwd: '/work/project',
        env: [], timeoutMs: Math.min(setup.timeoutMs ?? 600_000, envSec.maxExecMs),
        maxStdout: envSec.maxOutputBytes, maxStderr: envSec.maxOutputBytes,
      });
    } catch (e) {
      rec.state = 'setup_failed'; await saveRegistry();
      await tearDownWorker(rec);
      throw new RuntimeError('setup_exec_failed', e.message);
    }
    if (res.timedOut || res.exitCode !== 0) {
      rec.state = 'setup_failed'; rec.setupError = tailOf(res.stderr, 2000);
      await saveRegistry();
      // Honest failure — the dep set simply does not become ready.
      await tearDownWorker(rec);
      return {
        ok: false, depSetId, cached: false,
        error: { code: res.timedOut ? 'setup_timeout' : 'setup_failed',
          message: `setup argv exited ${res.exitCode}${res.timedOut ? ' (timeout)' : ''}`,
          stderrTail: tailOf(res.stderr, 4000) },
        controller: identity(),
      };
    }
    // Materialize: staging -> depSets/<id> with a readiness marker + meta.
    const finalView = path.join(depView, depSetId);
    await fs.rm(finalView, { recursive: true, force: true });
    await fs.rename(stagingView, finalView);
    // Setup workers are single-use — record+materials stay, container goes.
    await tearDownWorker(rec);
    rec.state = 'consumed';
    const dsRec = {
      schemaVersion: 1, id: depSetId, setupId, lockHash,
      projectRoot, snapshotSha: sha, source: src, canonicalId: p.canonicalId ?? null,
      depPath: setup.depPath, createdAt: new Date().toISOString(),
      state: 'ready', setupLog: tailOf(res.stdout + '\n' + res.stderr, 4000),
    };
    registry.depSets[depSetId] = dsRec;
    await saveRegistry();
    await atomicWriteJson(path.join(finalView, '.depset-meta.json'), dsRec, 0o600);
    return { ok: true, depSetId, cached: false, setupId, lockHash, snapshotSha: sha, canonicalId: p.canonicalId ?? null, controller: identity() };
  }

  async function depsStatus(p) {
    const id = p?.depSetId;
    const rec = registry.depSets[id];
    if (!rec) return { ok: true, depSetId: id, state: 'absent', controller: identity() };
    return { ok: true, depSetId: id, ...rec, controller: identity() };
  }

  // deps.check: run the declared checkArgv inside a constrained worker that
  // mounts the dep set read-only at its declared path. Real verification —
  // the dep set is actually consumed.
  async function depsCheck(p) {
    const depSetId = p?.depSetId;
    const ds = registry.depSets[depSetId];
    if (!ds || ds.state !== 'ready') {
      throw new RuntimeError('deps_not_prepared', `depSet ${depSetId} not materialized`);
    }
    const setup = config.setups[ds.setupId];
    if (!setup?.checkArgv?.length) {
      throw new RuntimeError('setup_no_check', `setup ${ds.setupId} declares no checkArgv`);
    }
    const workerId = `w-check-${depSetId.slice(0, 24)}`;
    const wv = path.join(workersView, workerId);
    const prior = registry.workers[workerId];
    if (prior?.containerId) await tearDownWorker(prior);
    delete registry.workers[workerId];
    await fs.rm(wv, { recursive: true, force: true });
    for (const d of ['conf', 'agent', 'home', 'attempt', 'inputs', 'project']) {
      await ensureDir(path.join(wv, d));
    }
    await atomicWriteJson(path.join(wv, 'conf', 'profile-flags.json'), [], 0o600);
    await atomicWriteJson(path.join(wv, 'conf', 'porch-config.json'), { agents: {} }, 0o600);
    await fs.writeFile(path.join(wv, 'conf', 'prompt.md'), '(check worker)', { mode: 0o600 });
    const src = ds.canonicalId ? (await registeredCanonical(ds.canonicalId)).worktree : await projectSource(ds.projectRoot);
    await gitArchiveExtract(src, ds.snapshotSha, path.join(wv, 'project'));
    // Pre-create the dep mountpoint — docker can't mkdir under the ro bind.
    await ensureDir(path.join(wv, 'project', setup.depPath));
    const binds = [
      [`${workersHost}/${workerId}/conf`, '/work/conf', 'ro'],
      [`${workersHost}/${workerId}/agent`, '/work/agent', 'rw'],
      [`${workersHost}/${workerId}/home`, '/work/home', 'rw'],
      [`${workersHost}/${workerId}/attempt`, '/work/attempt', 'rw'],
      [`${workersHost}/${workerId}/inputs`, '/work/inputs', 'ro'],
      [`${workersHost}/${workerId}/project`, '/work/project', 'ro'],
      [`${depHost}/${depSetId}`, `/work/project/${setup.depPath}`, 'ro'],
    ];
    const image = config.images.worker;
    const rec = {
      schemaVersion: 1, workerId, attemptId: `check-${depSetId}`,
      role: 'setup', profileDigest: `check-${depSetId}`, profileId: 'check',
      imageRef: image.ref, createdAt: new Date().toISOString(),
      state: 'prepared', workerDir: wv,
      hostDir: path.join(workersHost, workerId),
      binds: binds.map(([source, target, mode]) => ({ source, target, mode })),
      containerName: `${envSec.workerNamePrefix}${workerId}`,
      netName: `${envSec.networkNamePrefix}${workerId}`.slice(0, 120),
      project: { mode: 'check', sha: ds.snapshotSha },
      depSetId, containerId: null, gone: false,
    };
    const img = await docker.imageInspect(image.ref);
    rec.imageId = img.Id;
    registry.workers[workerId] = rec;
    await saveRegistry();
    const net = await prepareWorkerNet(workerId);
    rec.netId = net.id;
    const spec = workerContainerSpec(workerId, rec, net.name, binds);
    const created = await docker.containerCreate(spec);
    rec.containerId = created.Id;
    await saveRegistry();
    await docker.containerStart(created.Id);
    const res = await execInWorker(workerId, setup.checkArgv, {
      cwd: '/work/project', env: [],
      timeoutMs: Math.min(setup.checkTimeoutMs ?? 120_000, envSec.maxExecMs),
      maxStdout: envSec.maxOutputBytes, maxStderr: envSec.maxOutputBytes,
    });
    const passed = res.ok === true && res.timedOut !== true && res.exitCode === 0;
    // Check workers are single-use — the container is removed but the record
    // and materials stay on disk as evidence.
    await tearDownWorker(rec);
    rec.state = 'consumed';
    await saveRegistry();
    return {
      ok: true, depSetId, passed,
      exitCode: res.exitCode, timedOut: res.timedOut === true,
      stdoutTail: tailOf(res.stdout, 4000), stderrTail: tailOf(res.stderr, 4000),
      controller: identity(),
    };
  }

  // ---- dispatch ---------------------------------------------------------------

  const methods = {
    'ping': async () => ({ ok: true, controller: identity() }),
    'worker.prepare': workerPrepare,
    'worker.status': workerStatus,
    'worker.list': workerList,
    'worker.freeze': p => exclusive(`worker:${p.workerId}`, () => workerFreeze(p)),
    'worker.thaw': p => exclusive(`worker:${p.workerId}`, () => workerThaw(p)),
    'worker.stop': p => exclusive(`worker:${p.workerId}`, () => workerStop(p)),
    'worker.remove': p => exclusive(`worker:${p.workerId}`, () => workerRemove(p)),
    'worker.exec': workerExec,
    'canonical.prepare': canonicalPrepare,
    'canonical.status': canonicalStatus,
    'repo.import': repoImport,
    'deps.prepare': p => exclusive(p.canonicalId ? `canonical:${p.canonicalId}` : `deps:${p.setupId}:${p.projectRoot}`, () => depsPrepare(p)),
    'swarm.snapshot': p => exclusive(`canonical:${p.canonicalId}`, () => swarmSnapshot(p)),
    'deps.status': depsStatus,
    'deps.check': depsCheck,
    'registry.snapshot': async () => ({ ok: true, registry, controller: identity() }),
  };

  // Re-scan docker state against the registry at boot — the honest restart
  // path: live workers are restored to 'running', vanished ones are 'gone'
  // and never recreated.
  async function reconcileOnce() {
    for (const [wid, rec] of Object.entries(registry.workers)) {
      if (!rec.containerId) continue;
      let { state, inspectError } = await inspectWorker(rec);
      if (!inspectError && rec.freezeRequested && !rec.stopRequested && state === 'running') {
        // A crash between durable freeze intent and Docker pause cannot
        // admit writers on restart. Retry the physical barrier first.
        await workerFreeze({ workerId: wid });
        state = 'paused';
      }
      if (!inspectError) rec.frozen = state === 'paused';
      // A failed inspect carries no evidence about the container — keep the
      // last durable state untouched. A boot-time daemon error must never
      // mass-mark live workers gone.
      if (inspectError) continue;
      // Transitional (created/restarting/removing) and unclassifiable
      // states keep their honest docker status; only exited|dead become
      // 'stopped', only confirmed 404 becomes 'gone'.
      if (rec.state === 'removed' || rec.state === state) continue;
      rec.state = state;
      if (state === 'gone') { rec.gone = true; rec.goneAt = new Date().toISOString(); }
    }
    await saveRegistry();
  }

  async function handle(method, params) {
    const fn = methods[method];
    if (!fn) throw new RuntimeError('unknown_method', `no such method: ${method}`);
    return fn(params || {});
  }

  return {
    handle, identity, registry,
    boot: async () => {
      await ensureDir(workersView);
      await ensureDir(canonView);
      await ensureDir(depView);
      await ensureDir(path.join(envRoot, 'controller'));
      await loadRegistry();
      await reconcileOnce();
    },
  };
}

// ---------- RPC listener (exported for tests) -----------------------------------

export function createRpcListener({ controller, token, maxBytes }) {
  return http.createServer((req, res) => {
    const finish = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.method !== 'POST' || req.url !== '/rpc') {
      return finish(404, { ok: false, error: { code: 'not_found', message: 'no such route' } });
    }
    const presented = req.headers['x-acp-internal-token'];
    const a = Buffer.from(String(presented ?? ''), 'utf8');
    const b = Buffer.from(token, 'utf8');
    const max = Math.max(a.length, b.length, 1);
    const pa = Buffer.alloc(max), pb = Buffer.alloc(max);
    a.copy(pa); b.copy(pb);
    if (a.length !== b.length || !crypto.timingSafeEqual(pa, pb)) {
      return finish(401, { ok: false, error: { code: 'unauthorized', message: 'bad channel token' } });
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes + 4096) chunks.push(c);
      else req.destroy();
    });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(400, { ok: false, error: { code: 'bad_json', message: 'request is not JSON' } }); }
      try {
        const result = await controller.handle(parsed?.method, parsed?.params || {});
        finish(200, { ok: true, result });
      } catch (e) {
        const code = e instanceof RuntimeError ? e.code : 'internal_error';
        finish(200, { ok: false, error: { code, message: e.message || 'internal error' } });
      }
    });
    req.on('error', () => {});
  });
}

// ---------- daemon entrypoint ---------------------------------------------------

async function provisionToken(tokenFile) {
  await ensureDir(path.dirname(tokenFile));
  let t = null;
  try {
    t = (await fs.readFile(tokenFile, 'utf8')).trim();
    if (!/^[0-9a-f]{48}$/.test(t)) t = null;
  } catch { /* absent */ }
  if (!t) {
    t = crypto.randomBytes(24).toString('hex');
    await fs.writeFile(tokenFile, t + '\n', { mode: 0o600 });
  }
  await fs.chmod(tokenFile, 0o600).catch(() => {});
  return t;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfgIdx = argv.indexOf('--config');
  const cfgFile = cfgIdx >= 0 ? argv[cfgIdx + 1]
    : process.env.ACP_F1_CONFIG || '/run/f1/environment.config.json';
  const config = loadEnvironmentConfigSync(cfgFile, { env: process.env, view: 'controller' });
  const docker = createDockerApi({
    socketPath: process.env.ACP_F1_DOCKER_SOCK || '/var/run/docker.sock',
  });
  if (!(await docker.ping())) {
    log('FATAL: docker socket unreachable — controller cannot start');
    process.exit(2);
  }
  const token = await provisionToken(config.environment.tokenFile);
  const controller = createEnvController({ config, docker });
  await controller.boot();
  log(`boot ok: registry restored, socket=${config.environment.socketPath}`);

  const server = createRpcListener({
    controller, token, maxBytes: config.environment.maxInputBytes,
  });
  server.timeout = 0;               // exec calls own the deadline
  server.keepAliveTimeout = 0;
  const sock = config.environment.socketPath;
  await fs.rm(sock, { force: true }).catch(() => {});
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(sock, () => resolveListen());
  });
  await fs.chmod(sock, 0o600).catch(() => {});
  log(`listening on ${sock}`);
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '')
      === path.resolve(new URL(import.meta.url).pathname);
  } catch { return false; }
})();
if (isMain) {
  main().catch((e) => { log(`FATAL: ${e.stack || e}`); process.exit(2); });
}
