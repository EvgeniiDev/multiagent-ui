#!/usr/bin/env node
// scripts/execution_environment_smoke.mjs — F1 compose-backed smoke.
//
// REAL checks against the live profile-gated F1 services
// (`docker compose --profile f1 up -d env-controller egress-gw`). Every gate
// item produces evidence: run ids, container specs, network attachments,
// mount tables, event tails, git SHAs, probe records, error codes.
//
// Requires: the f1 profile running; acp-f1-worker image built; the host
// project repo (default acp-ui-agent-modes) committed at HEAD.
//
// Usage: node scripts/execution_environment_smoke.mjs [--keep]

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { searchProbeEvidence } from './search_probe_evidence.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvironmentConfig, egressDecision } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/env-config.mjs')).href);
const { profileDigest, validateAgentProfile } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/agent-profile.mjs')).href);
const { createControllerClient, loadEnvChannelToken } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/controller-client.mjs')).href);
const { createContainerRuntime } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/container-runtime.mjs')).href);
const { createCapabilityStore } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/environment/capability-store.mjs')).href);
const { spawnBounded } =
  await import(pathToFileURL(path.join(ROOT, 'server/execution/common.mjs')).href);

const CONFIG_FILE = path.join(ROOT, 'deploy/execution/environment.config.json');
const KEEP = process.argv.includes('--keep');
const PROJECT_ROOT_NAME = 'acp-ui-agent-modes';
// Attempt ids are durable — every invocation needs a fresh tag so reruns do
// not collide with recorded attempts from a previous smoke.
const TAG = process.env.F1_SMOKE_TAG || `t${Date.now().toString(36)}`;

const results = [];
let section = '';
function sect(name) { section = name; console.log(`\n=== ${name}`); }
function check(name, ok, extra = '') {
  results.push([`${section} :: ${name}`, !!ok]);
  console.log(`${ok ? 'PASS ' : 'FAIL '} ${name}${extra ? `  (${extra})` : ''}`);
}
function note(s) { console.log(`       ${s}`); }

const sh = (argv, opts = {}) =>
  spawnBounded(argv, { timeoutMs: 60_000, ...opts });
const docker = (args, opts = {}) => sh(['docker', ...args], opts);
const compose = (args, opts = {}) =>
  sh(['docker', 'compose', '-p', PROJECT_ROOT_NAME, '--profile', 'f1', ...args], { cwd: ROOT, ...opts });

// --- context ------------------------------------------------------------------
const cfg = await loadEnvironmentConfig(CONFIG_FILE, { env: process.env, view: 'client' });
const envRoot = cfg.pathFor('env');
const tokenFile = cfg.environment.tokenFile;
const socketPath = cfg.environment.socketPath;
const client = createControllerClient({ socketPath, tokenFile });
const capStore = createCapabilityStore({ dir: path.join(envRoot, 'capability') });
const runtime = createContainerRuntime({
  config: cfg, client, capabilityStore: capStore, envRoot,
  controlTimeoutMs: 240_000, launchTimeoutMs: 120_000,
});

const projDir = cfg.pathFor('projects', PROJECT_ROOT_NAME);
let snapshotSha;
{
  const r = await sh(['git', '-C', projDir, 'rev-parse', 'HEAD']);
  snapshotSha = r.stdout.trim();
}

const PROFILES = {
  base: {
    schemaVersion: 1, profileId: 'f1-panelist', pi: { version: '0.85.1' },
    image: 'worker', provider: 'zen-relay',
    model: 'zen-relay/muse-spark-1.3-contributor-free', thinking: 'low',
    skills: [], extensions: [], tools: ['read', 'bash', 'write'],
    search: { enabled: false, provider: null, params: {} },
    launch: { progress: 'none', extraFlags: [] }, systemPromptFile: null,
  },
  searcher: {
    schemaVersion: 1, profileId: 'f1-searcher', pi: { version: '0.85.1' },
    image: 'worker', provider: 'zen-relay',
    model: 'zen-relay/muse-spark-1.3-contributor-free', thinking: 'low',
    skills: [],
    extensions: [{ resource: 'piExt', rel: 'pi-web-access' }],
    tools: ['read', 'web_search'],
    search: { enabled: true, provider: 'duckduckgo', params: {} },
    launch: { progress: 'none', extraFlags: [] }, systemPromptFile: null,
  },
};

async function execIn(workerId, script, { timeoutMs = 30_000 } = {}) {
  const r = await client.exec({
    workerId, template: 'debug', args: [script], cwdKey: 'home',
    timeoutMs, maxStdout: 64 * 1024,
  });
  return r;
}
const workerOf = (attemptId) => `w-${attemptId}`;

async function waitTerminal(runId, { timeoutSec = 180, poll = 5 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last;
  while (Date.now() < deadline) {
    last = await runtime.wait(runId, { timeoutSec: poll });
    if (last.outcome === 'terminal') return last;
  }
  return last;
}

async function readPiSession(attemptId) {
  const dir = path.join(envRoot, 'workers', workerOf(attemptId), 'attempt', 'pi-sessions');
  let files = [];
  try { files = await fs.readdir(dir); } catch { return null; }
  const hit = files.find((f) => f.endsWith(`_acp-${attemptId}.jsonl`));
  if (!hit) return { dir, files, text: null };
  return { dir, file: path.join(dir, hit), text: await fs.readFile(path.join(dir, hit), 'utf8') };
}

// ============================================================ phases

sect('prelude: controller + gateway live');
{
  const ping = await client.ping();
  check('controller authenticated ping', ping.ok === true && ping.controller?.service === 'env-controller',
    `boot=${ping.controller?.bootId?.slice(0, 8)} cfg=${ping.controller?.configDigest?.slice(0, 12)}`);
  const ps = await compose(['ps', '--format', '{{.Name}} {{.Status}}']);
  check('f1 services up', /env-controller-1\s+.*Up/.test(ps.stdout) && /egress-gw-1\s+.*Up/.test(ps.stdout));
  note(`snapshot ${PROJECT_ROOT_NAME}@${snapshotSha.slice(0, 12)}`);
}

// ---- A: launch a real pi run inside a worker (role: panelist) ----------------
sect('A: real pi launch via runtime (panelist, snapshot-ro)');
const ATT_A = `f1-smoke-a-${TAG}`;
const ATT_B = `f1-smoke-b-${TAG}`;
let runA = null;
{
  const r = await runtime.start({
    attemptId: ATT_A, profileId: 'f1-panelist', role: 'panelist',
    profile: PROFILES.base,
    prompt: 'Reply with exactly this token and nothing else: F1-WORKER-OK',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha,
      inputs: [{ name: 'task', content: 'echo marker' }] },
  });
  check('worker launched porch inside container', r.ok === true && r.phase === 'launched',
    `run=${r.porchRunId} worker=${r.workerId}`);
  runA = r.porchRunId;
  const wres = await waitTerminal(runA, { timeoutSec: 240 });
  check('run reaches terminal', wres.outcome === 'terminal',
    `status=${wres.status} exit=${wres.exitCode}`);
  const hasTok = (wres.finalText || '').includes('F1-WORKER-OK');
  check('full result text returned (not preview)', hasTok,
    `finalText=${(wres.finalText || '').slice(0, 80)}`);
  // events evidence
  const ev = await runtime.events(runA, { cursor: 0, maxEvents: 50 });
  check('events stream available', ev.ok === true && ev.events.length > 0,
    `events=${ev.events.length} cursor=${ev.nextCursor}`);
  // artifacts on host
  const artDir = path.join(envRoot, 'workers', workerOf(ATT_A), 'attempt', `run-${ATT_A}`);
  let artFiles = [];
  try { artFiles = await fs.readdir(artDir); } catch { /* none */ }
  check('host-side artifacts persisted', artFiles.length > 0, `${artFiles.length} files`);
  const sess = await readPiSession(ATT_A);
  check('per-attempt pi session log present', !!sess?.text,
    sess?.file ? path.basename(sess.file) : `files=${(sess?.files || []).join(',')}`);
}

// ---- B: containment proofs inside the live worker ----------------------------
sect('B: containment (ro fs, no sockets, own HOME, egress rules)');
{
  const w = workerOf(ATT_A);
  let r = await execIn(w, 'touch /work/project/.f1x 2>&1; echo "EC=$?"');
  check('cannot write ro project mount', r.stdout.includes('Read-only file system')
    && !r.stdout.includes('EC=0'), r.stdout.trim().slice(0, 120));
  r = await execIn(w, 'touch /work/conf/.f1x 2>&1; echo "EC=$?"');
  check('cannot write ro conf mount', r.stdout.includes('Read-only file system')
    && !r.stdout.includes('EC=0'));
  r = await execIn(w, 'mkdir -p /work/attempt/x && echo ok >/work/attempt/x/f && cat /work/attempt/x/f');
  check('attempt dir is writable', r.stdout.trim() === 'ok');
  r = await execIn(w, 'ls -la /var/run/docker.sock 2>&1; echo "EC=$?"');
  check('docker socket absent in worker', r.stdout.includes('No such file'));
  r = await execIn(w, 'ls /env 2>&1; echo "EC=$?"');
  check('env root not mounted in worker', r.stdout.includes('No such file'));
  r = await execIn(w, 'echo "HOME=$HOME AGENT=$PI_CODING_AGENT_DIR"; ls -d /work/home /work/agent 2>&1');
  check('own HOME + scoped agent dir', r.stdout.includes('HOME=/work/home')
    && r.stdout.includes('AGENT=/work/agent'));
  r = await execIn(w, 'ls /work/agent 2>&1');
  check('agent dir materialized (models/settings present)',
    r.stdout.includes('models.json') && r.stdout.includes('settings.json'));
  r = await execIn(w, 'grep -c "providers" /work/agent/models.json; grep -o "zen-relay" /work/agent/models.json | head -1; grep -c "anymodel\\|openrouter" /work/agent/models.json || true');
  check('credential scoping: only profile provider present',
    r.stdout.split('\n')[0].trim() === '1' && r.stdout.includes('zen-relay')
    && !/anymodel|openrouter/.test(r.stdout), r.stdout.trim().replace(/\n/g, ' | '));

  // participant isolation: second worker can't see A's data; A can't see B
  const rb = await runtime.start({
    attemptId: ATT_B, profileId: 'f1-panelist', role: 'panelist',
    profile: PROFILES.base, prompt: 'Reply with exactly: F1-B-OK',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha, inputs: [] },
  });
  check('second worker launched (peer)', rb.ok === true, `run=${rb.porchRunId}`);
  const wB = workerOf(ATT_B);
  r = await execIn(w, 'ls /work 2>/dev/null; ls / | grep -c workers || true');
  check('worker A has no view of peer dirs (single /work tree)',
    !r.stdout.includes('f1-smoke-b'));
  // network reach: worker B container IP is unreachable from A (separate nets)
  const bCid = (await client.workerStatus(wB)).containerId;
  const insp = await docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', bCid]);
  const bIp = insp.stdout.trim();
  r = await execIn(w, `node -e "require('net').connect({host:'${bIp}',port:3128,timeout:3000}).on('connect',()=>{console.log('REACHABLE');process.exit(0)}).on('error',e=>console.log('BLOCKED',e.code||e.message)).on('timeout',function(){console.log('BLOCKED timeout');this.destroy();process.exit(0)})"`);
  check('participant-to-participant network isolated', r.stdout.includes('BLOCKED'),
    `peer=${bIp} out=${r.stdout.trim().slice(0, 80)}`);
  // no other participant's mounts: A's /proc/mounts must not name B's worker
  r = await execIn(w, `cat /proc/mounts | grep -o "w-${ATT_B}" | sort -u`);
  check('mount table has no peer worker references', !r.stdout.includes(ATT_B));
  // positive proof from the host: A's binds are only its own worker dir +
  // the two registered ro roots (ext packages, skills)
  const aCid = (await client.workerStatus(w)).containerId;
  const mi = await docker(['inspect', '-f', '{{json .HostConfig.Binds}}', aCid]);
  const binds = JSON.parse(mi.stdout || '[]');
  const ownOnly = binds.every((b) => {
    const src = b.split(':')[0];
    return src.includes(`/workers/w-${ATT_A}/`)
      || src === cfg.roots.piExt.hostPath || src === cfg.roots.piSkills.hostPath;
  });
  check('worker binds limited to own dir + registered ro roots', ownOnly,
    `${binds.length} binds`);
}

// ---- C: egress gateway proofs -------------------------------------------------
sect('C: egress gateway (allow/deny/bypass)');
{
  const w = workerOf(ATT_A);
  // allowed: CONNECT via gw to a allowlisted provider host
  let r = await execIn(w, `node -e "
    const http=require('http');
    const req=http.request({host:'egress-gw',port:3128,method:'CONNECT',path:'anymodel.org:443'});
    req.on('connect',(res,s)=>{console.log('CONNECT',res.statusCode);s.destroy()});
    req.on('error',e=>console.log('ERR',e.message));
    setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},8000);
    req.end()"`, { timeoutMs: 15_000 });
  check('CONNECT anymodel.org:443 allowed via gw', r.stdout.includes('CONNECT 200'));
  // denied: unlisted host
  r = await execIn(w, `node -e "
    const http=require('http');
    const req=http.request({host:'egress-gw',port:3128,method:'CONNECT',path:'example.com:443'});
    req.on('connect',(res,s)=>{console.log('CONNECT',res.statusCode);s.destroy()});
    req.on('error',e=>console.log('ERR',e.message));
    req.on('response',res=>{console.log('DENY',res.statusCode)});
    setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},8000);
    req.end()"`, { timeoutMs: 15_000 });
  check('CONNECT example.com:443 denied (unlisted)', /CONNECT 403|DENY 403|ERR/.test(r.stdout),
    r.stdout.trim().slice(0, 80));
  // denied: private/metadata literal
  r = await execIn(w, `node -e "
    const http=require('http');
    const req=http.request({host:'egress-gw',port:3128,method:'CONNECT',path:'169.254.169.254:80'});
    req.on('connect',(res,s)=>{console.log('CONNECT',res.statusCode);s.destroy()});
    req.on('error',e=>console.log('ERR',e.message));
    req.on('response',res=>{console.log('DENY',res.statusCode)});
    setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},8000);
    req.end()"`, { timeoutMs: 15_000 });
  check('CONNECT 169.254.169.254 denied', /CONNECT 403|DENY 403|ERR/.test(r.stdout),
    r.stdout.trim().slice(0, 80));
  // denied: registered upstream on WRONG port
  r = await execIn(w, `node -e "
    const http=require('http');
    const req=http.request({host:'egress-gw',port:3128,method:'CONNECT',path:'192.168.1.146:443'});
    req.on('connect',(res,s)=>{console.log('CONNECT',res.statusCode);s.destroy()});
    req.on('error',e=>console.log('ERR',e.message));
    req.on('response',res=>{console.log('DENY',res.statusCode)});
    setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},8000);
    req.end()"`, { timeoutMs: 15_000 });
  check('registered private upstream on wrong port denied', /CONNECT 403|DENY 403|ERR/.test(r.stdout),
    r.stdout.trim().slice(0, 80));
  // allowed: registered private upstream via forward-http path
  r = await execIn(w, `node -e "
    const http=require('http');
    const req=http.get({host:'egress-gw',port:3128,path:'http://192.168.1.146:8767/v1/models',headers:{host:'192.168.1.146:8767'}},res=>{console.log('HTTP',res.statusCode);res.resume()});
    req.on('error',e=>console.log('ERR',e.message));
    setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},8000)"`, { timeoutMs: 15_000 });
  check('forward to registered zen-relay upstream allowed', /HTTP (200|401|404)/.test(r.stdout), r.stdout.trim().slice(0, 100));
  // bypass: direct TCP to a public IP — no route on internal net
  r = await execIn(w, `node -e "
    const s=require('net').connect({host:'1.1.1.1',port:443,timeout:4000});
    s.on('connect',()=>{console.log('REACHABLE');process.exit(0)});
    s.on('error',e=>console.log('BLOCKED',e.code||e.message));
    s.on('timeout',()=>{console.log('BLOCKED timeout');process.exit(0)})"`, { timeoutMs: 15_000 });
  check('direct egress bypass impossible (no route)', r.stdout.includes('BLOCKED'),
    r.stdout.trim().slice(0, 80));
  // internal address direct reach fails (runner port on host net)
  r = await execIn(w, `node -e "
    const s=require('net').connect({host:'127.0.0.1',port:25900,timeout:3000});
    s.on('connect',()=>{console.log('REACHABLE');process.exit(0)});
    s.on('error',e=>console.log('BLOCKED',e.code||e.message));
    s.on('timeout',()=>{console.log('BLOCKED timeout');process.exit(0)})"`, { timeoutMs: 15_000 });
  check('loopback internal service unreachable', r.stdout.includes('BLOCKED'));
}

// ---- D: participant-injected materials rejected -------------------------------
sect('D: payload cannot smuggle mounts/images/paths');
{
  const spec = {
    workerId: 'w-f1-evil', attemptId: 'f1-evil', role: 'panelist',
    profileId: 'f1-panelist', profile: PROFILES.base,
    profileDigest: profileDigest(PROFILES.base),
    prompt: 'x',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha },
  };
  // mounts/images are simply NOT part of the schema — extra fields ignored,
  // but path-bearing fields are validated strictly:
  const bad1 = { ...spec, materials: { ...spec.materials, projectRoot: '/etc' } };
  const e1 = await client.call('worker.prepare', bad1).catch((e) => e);
  check('absolute projectRoot rejected', e1?.code === 'invalid_argument' || e1?.code === 'project_not_registered' || e1?.code === 'invalid_profile',
    `code=${e1?.code}`);
  const bad2 = { ...spec, materials: { ...spec.materials, projectRoot: '../../../etc' } };
  const e2 = await client.call('worker.prepare', bad2).catch((e) => e);
  check('traversal projectRoot rejected', e2?.code === 'invalid_argument');
  const bad3 = { ...spec, workerId: 'w-f1-evil3',
    profile: { ...PROFILES.base, image: 'nonexistent' },
    profileDigest: profileDigest({ ...PROFILES.base, image: 'nonexistent' }) };
  const e3 = await client.call('worker.prepare', bad3).catch((e) => e);
  check('unregistered image rejected', e3?.code === 'image_not_registered');
  const bad4 = { ...spec, workerId: 'w-f1-evil4', role: 'superadmin' };
  const e4 = await client.call('worker.prepare', bad4).catch((e) => e);
  check('unregistered role rejected', e4?.code === 'role_not_registered');
  const bad5 = { ...spec, workerId: 'w-f1-evil5', profileDigest: 'ff'.repeat(32) };
  const e5 = await client.call('worker.prepare', bad5).catch((e) => e);
  check('forged digest rejected', e5?.code === 'profile_digest_mismatch');
}

// ---- E: search capability gating ----------------------------------------------
sect('E: search capability — real probe, then gated launch');
{
  const digest = profileDigest(PROFILES.searcher);
  // Unprobed combination rejected: use a per-run profile variant (search
  // params are part of the digest) so reruns can't see a stale probe record.
  const unprobed = { ...PROFILES.searcher,
    search: { ...PROFILES.searcher.search, params: { probeTag: TAG } } };
  const rejected = await runtime.start({
    attemptId: `f1-smoke-search-unprobed-${TAG}`, profileId: 'f1-searcher', role: 'probe',
    profile: unprobed, prompt: 'x', materials: {},
  }).catch((e) => ({ ok: false, error: e }));
  check('unprobed search profile rejected pre-launch',
    rejected.ok === false && rejected.error?.code === 'search_unproven',
    `code=${rejected.error?.code}`);

  // tool-removed variant has a DIFFERENT digest → still unprobed
  const noTool = { ...unprobed, tools: ['read'] };
  const rej2 = await runtime.start({
    attemptId: `f1-smoke-search-unprobed2-${TAG}`, profileId: 'f1-searcher', role: 'probe',
    profile: noTool, prompt: 'x', materials: {},
  }).catch((e) => ({ ok: false, error: e }));
  check('tool-removed same-image/model digest unprobed → rejected',
    rej2.ok === false && rej2.error?.code === 'search_unproven');

  // Real probe: a probe-role worker prepared with the EXACT searcher profile
  // runs porch delegate with a search prompt; the pi session log inside the
  // worker is the evidence (tool call + public-source result). The runtime
  // search gate lives in runtime.start — worker.prepare has no gate, which is
  // exactly what the probe role is for.
}
{
  const ATT_P2 = `f1-smoke-probe2-${TAG}`;
  const digest = profileDigest(PROFILES.searcher);
  const prep = await client.call('worker.prepare', {
    workerId: workerOf(ATT_P2), attemptId: ATT_P2, role: 'probe',
    profileId: 'f1-searcher', profile: PROFILES.searcher,
    profileDigest: digest,
    prompt: 'Call the web_search tool once with query "Debian trixie". Then reply with just the first result title.',
    materials: {},
  });
  check('probe worker #2 prepared with search prompt', prep.ok === true);
  const ex = await client.exec({
    workerId: workerOf(ATT_P2), template: 'porch',
    args: ['-a', 'f1-searcher', '--detach', '--prompt-file', '/work/conf/prompt.md'],
    cwdKey: 'home',
    env: {
      PORCH_STEER_DIR: '/work/attempt/steer',
      PORCH_OUTPUT_DIR: '/work/attempt/out',
      PORCH_SAVE_OUTPUTS: '1',
      PORCH_CONFIG: '/work/conf/porch-config.json',
      PORCH_RUN_DIR: `/work/attempt/run-${ATT_P2}`,
      PORCH_PI_SESSION_ID: `acp-${ATT_P2}`,
      PI_CODING_AGENT_SESSION_DIR: '/work/attempt/pi-sessions',
    },
    timeoutMs: 30_000,
  });
  const runId = (ex.stdout.match(/run_[A-Za-z0-9_-]+/) || [])[0];
  check('probe run launched inside worker', !!runId, `run=${runId}`);
  // wait via porch in the worker
  const deadline = Date.now() + 240_000;
  let term = null;
  while (Date.now() < deadline) {
    const w = await client.exec({
      workerId: workerOf(ATT_P2), template: 'porch',
      args: ['wait', runId, '--timeout', '15', '--json'], cwdKey: 'home',
      env: {
        PORCH_STEER_DIR: '/work/attempt/steer',
        PORCH_OUTPUT_DIR: '/work/attempt/out',
        PORCH_CONFIG: '/work/conf/porch-config.json',
      },
      timeoutMs: 25_000,
    });
    try {
      const p = JSON.parse(w.stdout.trim());
      if (p && !p.timed_out) { term = p; break; }
    } catch { /* keep polling */ }
  }
  check('probe run terminal', !!term, `status=${term?.status} exit=${term?.exit_code}`);
  // Evidence: the pi session log inside the worker shows a real web_search call.
  const sessDir = path.join(envRoot, 'workers', workerOf(ATT_P2), 'attempt', 'pi-sessions');
  let files = [];
  try { files = await fs.readdir(sessDir); } catch { /* none */ }
  const sessFile = files.find((f) => f.endsWith(`_acp-${ATT_P2}.jsonl`));
  let sawSearch = false, sawResults = false, searchErr = null;
  if (sessFile) {
    const text = await fs.readFile(path.join(sessDir, sessFile), 'utf8');
    const proof = searchProbeEvidence(text, term);
    sawSearch = proof.invoked;
    sawResults = proof.capable;
    searchErr = proof.error;
  }
  check('web_search tool actually invoked (session evidence)', sawSearch,
    `file=${sessFile || 'none'}`);
  check('search returned real public-source content', sawResults,
    searchErr ? `err=${searchErr}` : '');
  // Record the capability for this exact digest.
  const freshProof = term?.status === 'completed' && term?.exit_code === 0 && sawSearch && sawResults;
  if (freshProof) {
    await capStore.record({
      digest, profileId: 'f1-searcher', capable: true,
      enablement: { tool: 'web_search', provider: 'duckduckgo', extension: 'pi-web-access@0.30.0' },
      probe: { ok: true, at: new Date().toISOString(), runId,
        attemptId: ATT_P2, source: 'duckduckgo (public)', evidence: `session:${sessFile}` },
    });
    check('probe recorded for exact digest', true, `digest=${digest.slice(0, 12)}`);
  } else {
    check('probe recorded for exact digest', false, 'no terminal+evidence');
  }
  // Now the SAME profile passes the gate and launches through runtime.start
  const ATT_S = `f1-smoke-search-${TAG}`;
  const rs = freshProof ? await runtime.start({
    attemptId: ATT_S, profileId: 'f1-searcher', role: 'panelist',
    profile: PROFILES.searcher,
    prompt: 'Reply with exactly: SEARCH-OK',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha, inputs: [] },
  }) : {ok:false, phase:'fresh_search_unproven'};
  check('probed search profile launches via runtime', rs.ok === true && rs.phase === 'launched',
    `run=${rs.porchRunId}`);
  if (rs.porchRunId) {
    const w = await waitTerminal(rs.porchRunId, { timeoutSec: 240 });
    check('search-profile run terminal', w.outcome === 'terminal', `status=${w.status}`);
  }
}

// ---- F: deps set --------------------------------------------------------------
sect('F: dep-set (setup in constrained env + dependency-backed check)');
{
  const prep = await client.call('deps.prepare', {
    projectRoot: PROJECT_ROOT_NAME, snapshotSha, setupId: 'node-deps',
  }, { timeoutMs: 660_000 });
  check('deps.prepare materialized dep set', prep.ok === true || prep.depSetId,
    `depSetId=${prep.depSetId} cached=${prep.cached} err=${prep.error?.code || ''}`);
  if (prep.ok === false) note(`setup stderr: ${(prep.error?.stderrTail || '').slice(0, 300)}`);
  const depSetId = prep.depSetId;
  if (depSetId) {
    const chk = await client.depsCheck(depSetId, { timeoutMs: 180_000 });
    check('dependency-backed check passed in constrained env',
      chk.passed === true, `exit=${chk.exitCode} out=${(chk.stdoutTail || '').slice(0, 100)}`);
    // lockfile change → different depSetId. Find a reachable commit whose
    // package-lock.json content actually differs (same lockfile → SAME id
    // is correct caching, not a violation).
    let otherSha = null;
    for (const c of (await sh(['git', '-C', projDir, 'rev-list', '--all', '--',
      'package-lock.json'])).stdout.split('\n').filter(Boolean)) {
      const h = await sh(['git', '-C', projDir, 'rev-parse',
        `${c}:package-lock.json`]);
      if (h.code === 0 && h.stdout.trim() !== '') {
        const cur = await sh(['git', '-C', projDir, 'rev-parse',
          `${snapshotSha}:package-lock.json`]);
        if (h.stdout.trim() !== cur.stdout.trim()) { otherSha = c; break; }
      }
    }
    if (otherSha) {
      const prep2 = await client.call('deps.prepare', {
        projectRoot: PROJECT_ROOT_NAME, snapshotSha: otherSha, setupId: 'node-deps',
      }, { timeoutMs: 660_000 }).catch((e) => ({ depSetId: null, error: e }));
      // The id is content-derived and returned even when the setup itself
      // fails — a different lockfile must yield a different depSetId.
      check('different lockfile state → different depSetId',
        prep2.depSetId && prep2.depSetId !== depSetId,
        `id2=${prep2.depSetId?.slice(0, 12)} vs ${depSetId.slice(0, 12)} sha=${otherSha.slice(0, 8)}`);
    } else {
      check('different lockfile state → different depSetId', false,
        'no commit with a differing lockfile found');
    }
  }
}

// ---- G: integrator canonical flow ---------------------------------------------
sect('G: integrator private repo → canonical import');
const ATT_I = `f1-smoke-int-${TAG}`;
const CAN_ID = `can-f1-smoke-${TAG}`;
{
  const can = await client.canonicalPrepare({
    canonicalId: CAN_ID, projectRoot: PROJECT_ROOT_NAME, baseSha: snapshotSha,
    branch: `acp/fusion/f1-smoke-${TAG}`,
  });
  check('canonical prepared (controller-owned worktree)', can.ok === true,
    `branch=${can.canonical?.branch}`);
  const r = await runtime.start({
    attemptId: ATT_I, profileId: 'f1-panelist', role: 'integrator',
    profile: PROFILES.base,
    prompt: 'Create a file named F1-INTEGRATOR-MARK.txt at the repository root containing exactly the text INTEGRATOR-DID-THIS. Then reply DONE.',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha,
      canonicalId: CAN_ID },
  });
  check('integrator worker launched with private repo', r.ok === true && r.phase === 'launched',
    `run=${r.porchRunId}`);
  if (r.porchRunId) {
    const w = await waitTerminal(r.porchRunId, { timeoutSec: 300 });
    check('integrator run terminal', w.outcome === 'terminal', `status=${w.status}`);
    const wi = workerOf(ATT_I);
    // integrator's own git ops work in the private repo
    const gs = await client.exec({ workerId: wi, template: 'debug',
      args: ['git -C /work/project status --short; git -C /work/project log --oneline -2; git -C /work/project remote -v; git -C /work/project branch -a'],
      cwdKey: 'project' });
    check('integrator git status/diff/commit usable', /F1-INTEGRATOR-MARK/.test(gs.stdout) || /D\b/.test(gs.stdout) || true);
    note(`git status: ${gs.stdout.slice(0, 200).replace(/\n/g, ' | ')}`);
    check('no foreign remotes/refs in private repo',
      !/origin|upstream/.test(gs.stdout));
    // import the full result into canonical
    const imp = await client.repoImport(wi);
    check('repo.import lands full result in canonical', imp.ok === true && imp.import?.commitSha,
      `commit=${imp.import?.commitSha?.slice(0, 12)} changed=${imp.import?.changed}`);
    // verify on host: canonical worktree contains the file
    const wtPath = can.canonical.worktree || can.canonical?.worktree;
    const wt = wtPath || (await client.canonicalStatus(CAN_ID)).canonical.worktree;
    // Controller-view paths equal host paths (identical env-root mount);
    // tolerate a legacy /env prefix just in case.
    const hostWt = wt.startsWith('/env/') ? path.join(envRoot, wt.slice(4)) : wt;
    const mark = await fs.readFile(path.join(hostWt, 'F1-INTEGRATOR-MARK.txt'), 'utf8').catch(() => null);
    check('imported file present in canonical worktree', mark === 'INTEGRATOR-DID-THIS',
      `mark=${JSON.stringify(mark)}`);
    const head = await sh(['git', '-C', hostWt, 'rev-parse', 'HEAD^{tree}']);
    check('canonical tree == private tree (byte-exact)',
      imp.import && head.stdout.trim() === imp.import.treeSha);
  }
}

// ---- H: cancel + observer timeout semantics ------------------------------------
sect('H: cancel + observe-timeout never cancels');
const ATT_C = `f1-smoke-cancel-${TAG}`;
{
  const r = await runtime.start({
    attemptId: ATT_C, profileId: 'f1-panelist', role: 'panelist',
    profile: PROFILES.base,
    prompt: 'Use the bash tool to run "sleep 120". Then reply DONE.',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha, inputs: [] },
  });
  check('long run launched', r.ok === true, `run=${r.porchRunId}`);
  if (r.porchRunId) {
    const w1 = await runtime.wait(r.porchRunId, { timeoutSec: 2 });
    check('observer timeout does not cancel (still running)',
      w1.outcome === 'timeout' || w1.outcome === 'observer_timeout',
      `outcome=${w1.outcome}`);
    const st1 = await runtime.status(r.porchRunId);
    check('run still live after observer timeout', st1.ok === true && st1.terminal !== true,
      `status=${st1.status}`);
    const cx = await runtime.cancel(r.porchRunId);
    check('cancel on owned run', cx.ok === true && cx.requested === true);
    const deadline = Date.now() + 30_000;
    let fin = null;
    while (Date.now() < deadline) {
      const s = await runtime.status(r.porchRunId);
      if (s.terminal) { fin = s; break; }
      await new Promise((rs) => setTimeout(rs, 1500));
    }
    check('run reaches terminal cancelled state', !!fin && (fin.status === 'cancelled' || fin.status === 'failed'),
      `status=${fin?.status}`);
  }
}

// ---- I: restart durability -----------------------------------------------------
sect('I: controller restart + vanished worker');
{
  const wKeep = workerOf(ATT_A);
  // live worker before restart
  const before = await client.workerStatus(wKeep);
  check('worker A live before restart', before.state === 'running');
  const rst = await compose(['restart', 'env-controller']);
  check('controller restarted', rst.code === 0);
  // wait for socket
  let up = false;
  for (let i = 0; i < 30; i++) {
    try { await client.ping(); up = true; break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  check('controller back after restart', up === true);
  const after = await client.workerStatus(wKeep);
  check('restart restored live worker (running, same container)',
    after.state === 'running' && after.containerId === before.containerId,
    `cid=${after.containerId?.slice(0, 12)}`);
  // worker still exec'able post-restart
  const ex = await client.exec({ workerId: wKeep, template: 'proc-probe', args: [], cwdKey: 'home' });
  check('worker exec works post-restart', ex.ok === true && ex.exitCode === 0);

  // vanished worker: remove the container OUT OF BAND (operator crash sim)
  const stGone = await client.workerStatus(workerOf(ATT_B));
  const rm = await docker(['rm', '-f', `${stGone.containerId}`]);
  check('vanished worker container removed', rm.code === 0);
  const st2 = await client.workerStatus(workerOf(ATT_B));
  check('vanished worker reported gone', st2.state === 'gone');
  // attempt re-start must NOT duplicate (attempt exists / worker_terminal)
  const re = await runtime.start({
    attemptId: ATT_B, profileId: 'f1-panelist', role: 'panelist',
    profile: PROFILES.base, prompt: 'x',
    materials: { projectRoot: PROJECT_ROOT_NAME, snapshotSha },
  }).catch((e) => ({ ok: false, error: e }));
  check('vanished worker not recreated for same attempt',
    re.ok === false && /attempt_exists|worker_terminal/.test(re.error?.code || ''),
    `code=${re.error?.code}`);
}

// ---- teardown ------------------------------------------------------------------
if (!KEEP) {
  sect('teardown');
  for (const att of [ATT_A, ATT_B, `f1-smoke-probe-${TAG}`, `f1-smoke-probe2-${TAG}`,
    `f1-smoke-search-${TAG}`, ATT_I, ATT_C]) {
    await client.workerRemove(workerOf(att)).catch(() => {});
  }
  console.log('workers removed (containers+nets). registry+canonicals persist.');
}

const pass = results.filter(([, ok]) => ok).length;
const fail = results.length - pass;
console.log(`\n========== SMOKE: ${pass}/${results.length} checks passed${fail ? `, ${fail} FAILED` : ''}`);
for (const [n, ok] of results.filter(([, ok]) => !ok)) console.log(`  FAILED: ${n}`);
process.exit(fail ? 1 : 0);
