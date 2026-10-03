import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createEnvController } from '../deploy/execution/env-controller.mjs';
import { createDockerApi } from '../deploy/execution/docker-api.mjs';
import { profileDigest, profileFlags, porchAgentEntry } from '../server/execution/environment/agent-profile.mjs';

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
  return { root, project, sha, config, docker, controller, containers, calls, created, prepare, canonical, profile };
}


test('normal dirty import preserves additions binary bytes deletion and executable bit', async () => {
  const f=await fixture(), canonical=await f.canonical();
  f.config.roles.integrator={name:'integrator',projectMode:'private-repo',inputs:[],canonical:true};
  const {worker}=await f.prepare('w-normal-import',{canonicalId:canonical.id},'integrator');
  const priv=path.join(worker.workerDir,'project');
  await fs.rm(path.join(priv,'original.txt'));
  await fs.writeFile(path.join(priv,'binary.dat'),Buffer.from([0,255,1,13,10,0,128]));
  await fs.writeFile(path.join(priv,'new-file.txt'),'new content\n');
  await fs.writeFile(path.join(priv,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const result=await f.controller.handle('repo.import',{workerId:worker.workerId});
  assert.equal(result.ok,true);
  assert.deepEqual(await fs.readFile(path.join(canonical.worktree,'binary.dat')),Buffer.from([0,255,1,13,10,0,128]));
  assert.equal(await fs.readFile(path.join(canonical.worktree,'new-file.txt'),'utf8'),'new content\n');
  await assert.rejects(fs.stat(path.join(canonical.worktree,'original.txt')),{code:'ENOENT'});
  assert.equal((await fs.stat(path.join(canonical.worktree,'run.sh'))).mode & 0o111,0o111);
  assert.equal(git(canonical.worktree,'ls-files','--stage','run.sh').slice(0,6),'100755');
  assert.equal(git(canonical.worktree,'rev-parse','HEAD^{tree}'),result.import.treeSha);
});

test('unsupported escaping symlink fails preflight without changing canonical HEAD or bytes',async()=>{
  const f=await fixture(), canonical=await f.canonical();
  f.config.roles.integrator={name:'integrator',projectMode:'private-repo',inputs:[],canonical:true};
  const {worker}=await f.prepare('w-unsupported',{canonicalId:canonical.id},'integrator');
  const priv=path.join(worker.workerDir,'project'),oldHead=git(canonical.worktree,'rev-parse','HEAD');
  const original=await fs.readFile(path.join(canonical.worktree,'original.txt'));
  await fs.symlink('../../outside',path.join(priv,'escape'));
  await fs.writeFile(path.join(priv,'original.txt'),'worker changed original');
  await assert.rejects(f.controller.handle('repo.import',{workerId:worker.workerId}),{code:'import_preflight_failed'});
  assert.equal(git(canonical.worktree,'rev-parse','HEAD'),oldHead);
  assert.deepEqual(await fs.readFile(path.join(canonical.worktree,'original.txt')),original);
  assert.equal(git(canonical.worktree,'status','--porcelain'),'');
});

test('import preserves export-ignore files and literal export-subst bytes',async()=>{
  const f=await fixture(), canonical=await f.canonical();
  f.config.roles.integrator={name:'integrator',projectMode:'private-repo',inputs:[],canonical:true};
  const {worker}=await f.prepare('w-export-attributes',{canonicalId:canonical.id},'integrator');
  const priv=path.join(worker.workerDir,'project');
  await fs.writeFile(path.join(priv,'.gitattributes'),'original.txt export-ignore\nsubstitution.txt export-subst\n');
  const literal='$Format:%H$\n$Format:%an$\n';
  await fs.writeFile(path.join(priv,'substitution.txt'),literal);
  await fs.writeFile(path.join(priv,'original.txt'),'must remain present');
  const result=await f.controller.handle('repo.import',{workerId:worker.workerId});
  assert.equal(result.ok,true);
  assert.equal(await fs.readFile(path.join(canonical.worktree,'original.txt'),'utf8'),'must remain present');
  assert.equal(await fs.readFile(path.join(canonical.worktree,'substitution.txt'),'utf8'),literal);
  assert.equal(git(canonical.worktree,'rev-parse','HEAD^{tree}'),result.import.treeSha);
});

test('planted worker index temporary symlink cannot overwrite a controller host file',async()=>{
  const f=await fixture(), canonical=await f.canonical();
  f.config.roles.integrator={name:'integrator',projectMode:'private-repo',inputs:[],canonical:true};
  const {worker}=await f.prepare('w-tmp-symlink',{canonicalId:canonical.id},'integrator');
  const priv=path.join(worker.workerDir,'project');
  const marker=path.join(f.root,'host-marker-outside-worker');
  const sentinel='HOST FILE MUST NOT CHANGE';
  await fs.writeFile(marker,sentinel);
  await fs.symlink(marker,path.join(priv,'.git',`index.safe-${process.pid}`));
  await fs.writeFile(path.join(priv,'new.txt'),'new content');
  const result=await f.controller.handle('repo.import',{workerId:worker.workerId});
  assert.equal(result.ok,true,'safe publication also preserves successful normal import');
  assert.equal(await fs.readFile(marker,'utf8'),sentinel);
  assert.equal(await fs.readFile(path.join(canonical.worktree,'new.txt'),'utf8'),'new content');
});
