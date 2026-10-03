import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEnvController } from '../deploy/execution/env-controller.mjs';
import { profileDigest } from '../server/execution/environment/agent-profile.mjs';

const roots = [];
after(async () => { await Promise.all(roots.map(r => fs.rm(r, { recursive: true, force: true }))); });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-ext-')); roots.push(root);
  const names = ['env', 'projects', 'piCreds', 'piExt', 'piSkills', 'porchSkill'];
  for (const n of names) await fs.mkdir(path.join(root, n), { recursive: true });
  const registered = Object.fromEntries(names.map(n => [n, { mountPath: path.join(root,n), hostPath: path.join(root,n) }]));
  await fs.mkdir(path.join(root, 'porchSkill/scripts')); await fs.writeFile(path.join(root, 'porchSkill/scripts/porch'), '#!/bin/sh\n');
  await fs.writeFile(path.join(root, 'piCreds/models.json'), JSON.stringify({ providers: { test: { baseUrl: 'https://example.com', apiKey: 'test', models: [] } } }));
  const project = path.join(root, 'projects/project'); await fs.mkdir(project);
  git(project, 'init', '-q', '-b', 'main'); await fs.writeFile(path.join(project,'original.txt'), 'original');
  await fs.writeFile(path.join(project,'package-lock.json'), '{"version":1}');
  git(project, 'add', '-A'); git(project, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'initial');
  const sha = git(project, 'rev-parse', 'HEAD');
  const config = { roots: registered, pathFor: n => registered[n].mountPath,
    images: { worker: { ref: 'test' } }, roles: { participant: { name: 'participant', projectMode: 'snapshot-ro', inputs: [], canonical: false } },
    execPolicy: { templates: [], envKeys: new Set() }, egress: {},
    setups: { approved: { argv: ['npm', 'ci', '--ignore-scripts'], lockfiles: ['package-lock.json'], depPath: 'node_modules' } },
    environment: { registryFile: path.join(root,'env/registry.json'), workerUid: process.getuid(), workerGid: process.getgid(),
      maxPromptBytes: 10000, maxInputBytes: 10000, maxOutputBytes: 100000, maxExecMs: 10000,
      workerNamePrefix: 'test-', networkNamePrefix: 'test-', labelPrefix: 'test',
      egressGateway: { proxyUrl: 'http://proxy:3128', alias: 'proxy', labelSelector: 'test=proxy' } } };
  const containers = new Map(), calls = [], created = [];
  let id = 0;
  const docker = { imageInspect: async () => ({ Id: 'image' }), containerList: async () => [{ Id:'gateway', State:'running' }],
    networkInspect: async () => ({ Id:'network' }), networkCreate: async () => ({ Id:'network' }), networkConnect: async () => {},
    networkDisconnect: async () => {}, networkRemove: async () => {},
    containerCreate: async spec => { const cid = `container-${++id}`; created.push(spec); containers.set(cid, { Running: false, Status: 'created', Paused: false }); return { Id:cid }; },
    containerStart: async cid => { Object.assign(containers.get(cid), { Running:true, Status:'running' }); },
    containerInspect: async cid => containers.has(cid) ? { Id:cid, State: { ...containers.get(cid) } } : null,
    containerPause: async cid => { calls.push(['pause',cid]); Object.assign(containers.get(cid), { Paused:true, Status:'paused' }); },
    containerUnpause: async cid => { calls.push(['unpause',cid]); Object.assign(containers.get(cid), { Paused:false, Status:'running' }); },
    containerStop: async cid => { calls.push(['stop',cid]); Object.assign(containers.get(cid), { Running:false, Paused:false, Status:'exited' }); },
    containerRemove: async cid => { containers.delete(cid); },
    execCreate: async (cid, opts) => { calls.push(['exec',cid,opts.Cmd]); return 'exec'; },
    execStart: async () => ({ stdout:'', stderr:'', timedOut:false }), execInspect: async () => ({ ExitCode:0 }) };
  const controller = createEnvController({ config, docker }); await controller.boot();
  const profile = { schemaVersion:1, profileId:'test', pi:{ version:'0.85.1' }, image:'worker', provider:'test', model:'test/model', thinking:'low', skills:[], extensions:[], tools:['read'], search:{ enabled:false }, launch:{ progress:'none', extraFlags:[] }, systemPromptFile:null };
  const prepare = (workerId, materials = {}, role = 'participant') => controller.handle('worker.prepare', { workerId, attemptId:workerId.slice(2), role, profile, profileDigest:profileDigest(profile), prompt:'task', materials:{ projectRoot:'project', snapshotSha:sha, ...materials } });
  const canonical = async () => (await controller.handle('canonical.prepare', { canonicalId:'canonical', projectRoot:'project', snapshotSha:sha })).canonical;
  return { root, project, sha, config, docker, controller, containers, calls, created, prepare, canonical };
}

test('freeze and thaw use registered Docker container and preserve a paused live namespace', async () => {
  const f = await fixture(); const { worker } = await f.prepare('w-one');
  await f.controller.handle('worker.freeze', { workerId:'w-one' });
  assert.equal((await f.controller.handle('worker.status', { workerId:'w-one' })).state, 'paused');
  assert.equal(f.containers.get(worker.containerId).Running, true);
  await f.controller.handle('worker.freeze', { workerId:'w-one' });
  assert.equal(f.calls.filter(c => c[0] === 'pause').length, 1);
  await f.controller.handle('worker.thaw', { workerId:'w-one' });
  assert.deepEqual(f.calls.filter(c => ['pause','unpause'].includes(c[0])), [['pause',worker.containerId],['unpause',worker.containerId]]);
  await f.controller.handle('worker.stop', { workerId:'w-one' });
  await assert.rejects(f.controller.handle('worker.thaw', { workerId:'w-one' }));
  await assert.rejects(f.controller.handle('worker.freeze', { workerId:'unregistered' }));
});
test('boot restores durable freeze intent with a physical pause', async () => {
  const f = await fixture(); const { worker } = await f.prepare('w-one');
  worker.freezeRequested = true; worker.frozen = false;
  await fs.writeFile(f.config.environment.registryFile, JSON.stringify(f.controller.registry));
  const restarted = createEnvController({ config:f.config, docker:f.docker }); await restarted.boot();
  assert.equal(f.containers.get(worker.containerId).Paused, true);
  assert.equal(restarted.registry.workers['w-one'].frozen, true);
});
test('scratch mounts are isolated writable worker dirs while project remains read only', async () => {
  const f = await fixture(); await f.prepare('w-one', { scratch:{ id:'own', mount:'/work/scratch' } });
  await f.prepare('w-two', { scratch:{ id:'own', mount:'/work/scratch' } });
  const mount = spec => spec.HostConfig.Binds.find(b => b.includes(':/work/scratch:'));
  assert.equal(mount(f.created[0]), `${f.root}/env/workers/w-one/scratch:/work/scratch:rw`);
  assert.notEqual(mount(f.created[0]), mount(f.created[1]));
  assert.equal(f.created[0].HostConfig.Binds.some(b => b.endsWith(':/work/project:ro')), true);
  for (const scratch of [{ id:'../peer', mount:'/work/scratch' }, { id:'own', mount:'/work/project' }, { id:'own', mount:'/work/scratch', path:'/peer' }]) {
    await assert.rejects(f.prepare('w-invalid', { scratch }));
  }
});
test('swarm snapshot captures dirty additions deletions and executable mode, with immutable generation replay', async () => {
  const f = await fixture(); const canonical = await f.canonical();
  await fs.rm(path.join(canonical.worktree,'original.txt'));
  await fs.writeFile(path.join(canonical.worktree,'new.sh'), '#!/bin/sh\necho new\n', { mode:0o755 });
  const snap = await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, workspacePath:canonical.worktree, generation:1 });
  assert.equal(snap.materials.snapshotSha, snap.snapshotSha);
  await f.prepare('w-one', snap.materials);
  const workerProject = path.join(f.root,'env/workers/w-one/project');
  assert.equal(await fs.readFile(path.join(workerProject,'new.sh'),'utf8'), '#!/bin/sh\necho new\n');
  assert.equal((await fs.stat(path.join(workerProject,'new.sh'))).mode & 0o111, 0o111);
  await assert.rejects(fs.stat(path.join(workerProject,'original.txt')));
  const replay = await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 });
  assert.equal(replay.snapshotSha, snap.snapshotSha);
  await fs.writeFile(path.join(canonical.worktree,'new.sh'), 'changed');
  await assert.rejects(f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 }), { code:'snapshot_generation_conflict' });
  await assert.rejects(f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, workspacePath:f.project, generation:2 }));
  await assert.rejects(f.controller.handle('swarm.snapshot', { canonicalId:'unknown', generation:2 }));
});
test('canonical deps prepare hashes current committed locks using approved setup only', async () => {
  const f = await fixture(); const canonical = await f.canonical();
  const first = await f.controller.handle('deps.prepare', { setupId:'approved', canonicalId:canonical.id });
  assert.equal(first.ok, true); assert.equal(first.snapshotSha, f.sha);
  assert.deepEqual(f.calls.find(c => c[0] === 'exec')[2], ['npm','ci','--ignore-scripts']);
  await fs.writeFile(path.join(canonical.worktree,'package-lock.json'), '{"version":2}');
  await assert.rejects(f.controller.handle('deps.prepare', { setupId:'approved', canonicalId:canonical.id }), { code:'canonical_dirty' });
  await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 });
  const next = await f.controller.handle('deps.prepare', { setupId:'approved', canonicalId:canonical.id });
  assert.notEqual(next.lockHash, first.lockHash); assert.notEqual(next.depSetId, first.depSetId);
  const cached = await f.controller.handle('deps.prepare', { setupId:'approved', canonicalId:canonical.id }); assert.equal(cached.cached, true);
  await assert.rejects(f.controller.handle('deps.prepare', { setupId:'unknown', canonicalId:canonical.id }));
  await assert.rejects(f.controller.handle('deps.prepare', { setupId:'approved', canonicalId:canonical.id, argv:['bad'] }));
});
test('a freeze failure preserves durable intent, and restart retries the barrier', async () => {
  const f = await fixture(); const { worker } = await f.prepare('w-one');
  const pause = f.docker.containerPause; f.docker.containerPause = async () => { throw new Error('Docker unavailable'); };
  await assert.rejects(f.controller.handle('worker.freeze', { workerId:'w-one' }));
  const persisted = JSON.parse(await fs.readFile(f.config.environment.registryFile,'utf8'));
  assert.equal(persisted.workers['w-one'].freezeRequested, true);
  assert.equal(persisted.workers['w-one'].frozen, false);
  f.docker.containerPause = pause;
  const restarted = createEnvController({ config:f.config, docker:f.docker }); await restarted.boot();
  assert.equal(f.containers.get(worker.containerId).Paused, true);
});
test('pause acknowledgment without inspected pause cannot grant a barrier', async () => {
  const f = await fixture(); await f.prepare('w-one');
  f.docker.containerPause = async () => true;
  await assert.rejects(f.controller.handle('worker.freeze', { workerId:'w-one' }), { code:'worker_freeze_unconfirmed' });
  assert.equal(f.controller.registry.workers['w-one'].frozen, false);
});
test('inspection outage never pauses or unpauses an unverifiable worker', async () => {
  const f = await fixture(); await f.prepare('w-one');
  f.docker.containerInspect = async () => { throw new Error('inspection outage'); };
  await assert.rejects(f.controller.handle('worker.freeze', { workerId:'w-one' }));
  await assert.rejects(f.controller.handle('worker.thaw', { workerId:'w-one' }));
  assert.equal(f.calls.some(c => ['pause','unpause'].includes(c[0])), false);
});
test('stop intent blocks a paused worker from being thawed even before Docker stops it', async () => {
  const f = await fixture(); await f.prepare('w-one'); await f.controller.handle('worker.freeze', { workerId:'w-one' });
  const worker = f.controller.registry.workers['w-one']; worker.stopRequested = true;
  await fs.writeFile(f.config.environment.registryFile, JSON.stringify(f.controller.registry));
  const restarted = createEnvController({ config:f.config, docker:f.docker }); await restarted.boot();
  await assert.rejects(restarted.handle('worker.thaw', { workerId:'w-one' }), { code:'worker_terminal' });
  assert.equal(f.calls.some(c => c[0] === 'unpause'), false);
});
test('repeated worker prepare still rejects malformed or changed scratch binding', async () => {
  const f = await fixture(); await f.prepare('w-one', { scratch:{ id:'one', mount:'/work/scratch' } });
  await assert.rejects(f.prepare('w-one', { scratch:{ id:'one', mount:'/work/project' } }));
  await assert.rejects(f.prepare('w-one', { scratch:{ id:'two', mount:'/work/scratch' } }));
});
test('an old snapshot stays immutable after canonical advances and new worker materializes it', async () => {
  const f = await fixture(); const canonical = await f.canonical();
  await fs.writeFile(path.join(canonical.worktree,'original.txt'),'first');
  const first = await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 });
  await fs.writeFile(path.join(canonical.worktree,'original.txt'),'second');
  const second = await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:2 });
  assert.notEqual(first.snapshotSha, second.snapshotSha);
  await f.prepare('w-old',first.materials);
  assert.equal(await fs.readFile(path.join(f.root,'env/workers/w-old/project/original.txt'),'utf8'),'first');
  await assert.rejects(f.prepare('w-forged',{ ...first.materials, snapshotSha:second.snapshotSha }), { code:'snapshot_binding_mismatch' });
});
test('snapshot admission rejects active or unverifiable participants until physical pause', async () => {
  const f = await fixture(); const canonical = await f.canonical();
  f.config.roles['swarm-participant'] = { name:'swarm-participant', projectMode:'snapshot-ro', inputs:[], canonical:false };
  const initial = await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:0 });
  await f.prepare('w-one',initial.materials,'swarm-participant');
  await assert.rejects(f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 }), { code:'snapshot_workers_unfrozen' });
  await f.controller.handle('worker.freeze', { workerId:'w-one' });
  const inspect = f.docker.containerInspect;
  f.docker.containerInspect = async () => { throw new Error('outage'); };
  await assert.rejects(f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 }), { code:'snapshot_workers_unfrozen' });
  f.docker.containerInspect = inspect;
  const snapshot = await f.controller.handle('swarm.snapshot', { canonicalId:canonical.id, generation:1 });
  assert.equal(snapshot.ok,true);
});
test('Docker pause and unpause use exact encoded Engine endpoints and reject errors', async () => {
  const { default:http } = await import('node:http');
  const { createDockerApi } = await import('../deploy/execution/docker-api.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'docker-transport-')); roots.push(root);
  const requests = []; let reject = false;
  const server = http.createServer((req,res) => {
    if (req.url === '/version') { res.end(JSON.stringify({ ApiVersion:'1.49' })); return; }
    requests.push([req.method,req.url]); res.statusCode = reject ? 500 : 204; res.end();
  });
  await new Promise(resolve => server.listen(path.join(root,'fake.sock'),resolve));
  try {
    const api = createDockerApi({ socketPath:path.join(root,'fake.sock') });
    await api.containerPause('registered/id'); await api.containerUnpause('registered/id');
    assert.deepEqual(requests, [['POST','/v1.49/containers/registered%2Fid/pause'],['POST','/v1.49/containers/registered%2Fid/unpause']]);
    reject = true; await assert.rejects(api.containerPause('registered/id'), { code:'docker_api' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('stop drains a physically paused worker without thawing it', async () => {
  const f = await fixture(); const { worker } = await f.prepare('w-one');
  await f.controller.handle('worker.freeze', { workerId:'w-one' });
  f.docker.containerStop = async () => { throw new Error('paused containers cannot stop'); };
  const stopped = await f.controller.handle('worker.stop', { workerId:'w-one' });
  assert.equal(stopped.state,'gone'); assert.equal(f.containers.has(worker.containerId),false);
  assert.equal(f.calls.some(c => c[0] === 'unpause'),false);
  await assert.rejects(f.controller.handle('worker.thaw', { workerId:'w-one' }));
});

test('fromCanonical builds the current registered commit even when original project lacks that object', async () => {
  const f = await fixture(); const canonical = await f.canonical();
  f.config.roles.integrator = { name:'integrator', projectMode:'private-repo', inputs:[], canonical:true };
  await fs.writeFile(path.join(canonical.worktree,'canonical-only.txt'),'current canonical');
  git(canonical.worktree,'add','-A'); git(canonical.worktree,'-c','user.name=test','-c','user.email=test@test','commit','-qm','canonical change');
  const head = git(canonical.worktree,'rev-parse','HEAD');
  assert.throws(() => execFileSync('git', ['-C',f.project,'cat-file','-e',`${head}^{commit}`], { stdio:'pipe' }), 'source project does not have the canonical-only commit');
  const prepared = await f.prepare('w-fix', { canonicalId:canonical.id, snapshotSha:head, fromCanonical:true }, 'integrator');
  assert.equal(prepared.worker.project.sha,head);
  assert.equal(await fs.readFile(path.join(prepared.worker.workerDir,'project/canonical-only.txt'),'utf8'),'current canonical');
  assert.equal(git(path.join(prepared.worker.workerDir,'project'),'rev-parse','HEAD^{tree}'),git(canonical.worktree,'rev-parse','HEAD^{tree}'));
});

test('fromCanonical rejects stale HEAD and mismatched registered source bindings', async () => {
  const f = await fixture(); const canonical = await f.canonical();
  f.config.roles.integrator = { name:'integrator', projectMode:'private-repo', inputs:[], canonical:true };
  await fs.writeFile(path.join(canonical.worktree,'canonical-only.txt'),'current canonical');
  git(canonical.worktree,'add','-A'); git(canonical.worktree,'-c','user.name=test','-c','user.email=test@test','commit','-qm','canonical change');
  const head = git(canonical.worktree,'rev-parse','HEAD');
  await assert.rejects(f.prepare('w-stale', { canonicalId:canonical.id, snapshotSha:f.sha, fromCanonical:true },'integrator'), { code:'canonical_binding_mismatch' });
  await assert.rejects(f.prepare('w-wrong-project', { projectRoot:'wrong', canonicalId:canonical.id, snapshotSha:head, fromCanonical:true },'integrator'), { code:'canonical_binding_mismatch' });
  await assert.rejects(f.prepare('w-wrong-canonical', { canonicalId:'unknown', snapshotSha:head, fromCanonical:true },'integrator'), { code:'canonical_not_prepared' });
  await fs.writeFile(path.join(canonical.worktree,'canonical-only.txt'),'dirty change');
  await assert.rejects(f.prepare('w-dirty', { canonicalId:canonical.id, snapshotSha:head, fromCanonical:true },'integrator'), { code:'canonical_dirty' });
  assert.equal(f.created.length,0,'unproven sources never launch a worker');
});
