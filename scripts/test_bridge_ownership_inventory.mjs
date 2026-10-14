import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridges = ['hermes', 'opencode', 'devin', 'pi', 'codex'];
const ports = [25901, 25902, 25903, 25904, 25907];
const line = (port, pid, addr = '*') => `LISTEN 0 511 ${addr}:${port} *:*${pid ? ` users:(("node",pid=${pid},fd=18))` : ''}`;
function fixture() {
  return { docker: bridges.map((name, i) => ({ id: `id${i}`, container: `acp-ui-bridge-${name}-1`, service: `bridge-${name}`, pid: 1000+i,
    network: 'host', cmd: ['/repo/deploy/acp-bridge-launcher.sh', name, 'node', '/repo/deploy/acp-ws-bridge.mjs', '--port', String(ports[i])] })),
    units: {}, processOverrides: {}, listeners: ports.map((port, i) => line(port, 1000+i)), failures: [], extraUnits: [],
    execProofs: Object.fromEntries(bridges.map((name, i) => [name, { argv: ['node', '/repo/deploy/acp-ws-bridge.mjs', '--port', String(ports[i])], listeners: [String(9000+i)], inodes: [String(9000+i)] }])) };
}
const cases = {
  unknown: (f) => { f.docker.push({ id: 'evil', container: 'acp-ui-bridge-evil-1', service: 'bridge-evil' }); return /bridge-evil/; },
  'unknown-nonbridge': (f) => { f.docker.push({ id: 'evil', container: 'acp-ui-unexpected-1', service: 'unexpected' }); return /unexpected/; },
  ambiguous: (f) => { f.docker[0].service = ''; return /acp-ui-bridge-hermes-1/; },
  legacy: (f) => { f.units['acp-bridge-hermes.service'] = { state: 'active', pid: 2000 }; return /acp-bridge-hermes/; },
  'unknown-legacy': (f) => { f.extraUnits.push('acp-bridge-evil.service loaded active running unknown'); return /acp-bridge-evil/; },
  missing: (f) => { f.listeners.shift(); return /25901/; },
  unresolved: (f) => { f.docker = []; f.listeners = [line(25901, null)]; return /25901/; },
  swapped: (f) => { [f.listeners[0], f.listeners[1]] = [line(25901,1001), line(25902,1000)]; return /25901|25902/; },
  'wrong-command-port': (f) => { f.docker[0].cmd[5] = '25902'; return /25901/; },
  'root-docker-no-pid': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); return null; },
  'docker-direct-node-cmd': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); for (const d of f.docker) d.cmd = ['node', '/repo/deploy/acp-ws-bridge.mjs', '--port', String(ports[bridges.indexOf(d.service.replace(/^bridge-/,''))])]; return null; },
  'root-docker-wrong-proof': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); f.execProofs.opencode.argv[3] = '25999'; return /opencode|proof|25902/; },
  'root-docker-missing-proof': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); f.execProofs.opencode.inodes = []; return /opencode|proof|25902/; },
  'root-docker-exec-failure': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); f.failures.push('docker-exec'); return /docker|exec|proof/; },
  'root-docker-multiple-sockets': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); f.execProofs.pi.listeners.push('9005'); f.execProofs.pi.inodes.push('9005'); return /pi|proof|25904/; },
  'root-docker-malformed-proof': (f) => { for (const i of [1,2,3]) f.listeners[i] = line(ports[i], null); f.execProofs.devin = 'malformed'; return /devin|proof|25903/; },
  'unknown-pid': (f) => { f.listeners[0] = line(25901,9999); return /25901/; },
  'duplicate-owner': (f) => { f.docker.push({ ...f.docker[0], id: 'duplicate', container: 'acp-ui-bridge-hermes-2' }); return /hermes/; },
  'duplicate-listener': (f) => { f.listeners.push(line(25901,9999,'127.0.0.1')); return /25901/; },
  'duplicate-row': (f) => { f.listeners.push(f.listeners[0]); return /25901/; },
  mixed: (f) => { f.units['acp-ui-bridge-host@pi.service'] = { state: 'active', pid: 2000 }; return /host|both|mixed/i; },
  'wrong-mode': (f) => { f.mode = 'host'; return /selected|mode/; },
  'docker-query': (f) => { f.failures.push('docker-ps'); return /docker/; },
  'systemctl-query': (f) => { f.failures.push('systemctl-state'); return /systemctl|query/; },
  'ss-query': (f) => { f.failures.push('ss'); return /ss/; },
  'inspect-query': (f) => { f.failures.push('docker-inspect'); return /docker|inspect/; },
  'pid-query': (f) => { f.docker = []; f.units['acp-ui-bridge-host@hermes.service'] = { state: 'active', pid: 1000 }; f.listeners = [line(25901,1000)]; f.mode = 'host'; f.failures.push('systemctl-pid'); return /systemctl|PID/; },
  'transitional-unit': (f) => { f.units['acp-ui-bridge-host@hermes.service'] = { state: 'activating', pid: 1000 }; return /activating|hermes/; },
  'parallel-host-unit-start': (f) => { f.mode='host'; f.docker=[]; f.listeners=[line(25901,1000)]; bridges.forEach((n,i) => { f.units[`acp-ui-bridge-host@${n}.service`] = {state:i===0?'active':'activating',pid:1000+i}; }); return null; },
  'parallel-host-bound-peer': (f) => { f.mode='host'; f.docker=[]; f.units['acp-ui-bridge-host@hermes.service']={state:'active',pid:1000}; f.units['acp-ui-bridge-host@opencode.service']={state:'activating',pid:1001}; f.listeners=[line(25901,1000),line(25902,1001)]; return /unowned listener|25902/; },
  'wrong-host-process': (f) => { f.mode='host'; f.docker=[]; bridges.forEach((n,i) => { f.units[`acp-ui-bridge-host@${n}.service`] = {state:'active',pid:1000+i}; }); f.processOverrides[1000]=['node','/repo/server/acp-runner.mjs','--port','25901']; return /hermes|25901/; },
  'wrong-docker-process': (f) => { f.processOverrides[1000]=['node','/repo/server/acp-runner.mjs','--port','25901']; return /hermes|25901/; },
  'inactive-pid': (f) => { f.docker=[]; f.listeners=[]; f.units['acp-ui-bridge-host@hermes.service']={state:'inactive',pid:9999}; return /hermes|PID/; },
  malformed: (f) => { f.docker=[];f.listeners=['not an ss row'];return /listener|parse/; },
  'ready-with-state': (f) => { f.docker.push({id:'state',container:'acp-ui-state-1',service:'state'});return null; },
  ready: () => null,
  stopped: (f) => { f.docker=[]; f.listeners=[]; return null; },
  'host-ready': (f) => { f.mode='host'; f.docker=[]; bridges.forEach((n,i) => { f.units[`acp-ui-bridge-host@${n}.service`] = {state:'active',pid:1000+i}; }); return null; },
  dualstack: (f) => { f.listeners = ports.flatMap((p,i) => [line(p,1000+i,'0.0.0.0'),line(p,1000+i,'[::]')]); return null; },
};
const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-inventory-'));
let failed = 0;
try {
  for (const [name, change] of Object.entries(cases)) {
    if (process.env.CASE && process.env.CASE !== name) continue;
    const f = fixture(); const expected = change(f);
    const dir = path.join(temp, name); const bin = path.join(dir,'bin');
    await mkdir(bin,{recursive:true}); await mkdir(path.join(dir,'locks'));
    await writeFile(path.join(dir,'selected'),`${f.mode || 'docker'}\n`);
    await writeFile(path.join(dir,'fixture.json'),JSON.stringify(f));
    const procRoot=path.join(dir,'proc');
    for(let i=0;i<bridges.length;i++){const pid=1000+i;await mkdir(path.join(procRoot,String(pid)),{recursive:true});await writeFile(path.join(procRoot,String(pid),'cmdline'),(f.processOverrides[pid]||[process.execPath,path.join(ROOT,'deploy/acp-ws-bridge.mjs'),'--port',String(ports[i])]).join('\0')+'\0');}
    // Absolute Node interpreter; every command and argument form is checked.
    const fake = `#!${process.execPath}\nconst fs=require('node:fs');\nconst f=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir,'fixture.json'))},'utf8'));\nconst bin=require('node:path').basename(process.argv[1]), a=process.argv.slice(2);\nconst fail=(key)=>{if(f.failures.includes(key)){process.stderr.write('mock query failure '+key);process.exit(2);}};\nconst out=(s)=>{process.stdout.write(s);process.exit(0)};\nif(bin==='docker'&&a[0]==='ps'&&a.length===5&&a[1]==='--filter'&&a[2]==='label=com.docker.compose.project=acp-ui'&&a[3]==='--format'&&a[4]==='{{.ID}}\\t{{.Names}}\\t{{.Label "com.docker.compose.service"}}'){fail('docker-ps');out(f.docker.map(d=>[d.id,d.container,d.service].join('\\t')).join('\\n'));}\nif(bin==='docker'&&a[0]==='inspect'&&a[1]==='--format'&&a[2]==='{{.State.Pid}}\\t{{.HostConfig.NetworkMode}}\\t{{json .Config.Cmd}}'&&a.length===4){fail('docker-inspect');const d=f.docker.find(d=>d.id===a[3]);if(d)out([d.pid,d.network,JSON.stringify(d.cmd)].join('\\t'));}\nif(bin==='docker'&&a[0]==='exec'&&a.length===5&&a[2]==='node'&&a[3]==='-e'){fail('docker-exec');const d=f.docker.find(d=>d.container===a[1]);const name=d?.service?.replace(/^bridge-/,'');const proof=f.execProofs[name];if(proof==='malformed')out('{bad json');if(proof)out(JSON.stringify(proof));process.stderr.write('missing mocked proof');process.exit(2);}\nif(bin==='systemctl'&&a[0]==='--user'&&a[1]==='show'&&a[3]==='--value'&&a.length===5){const u=f.units[a[4]]||{state:'inactive',pid:0};if(a[2]==='--property=ActiveState'){fail('systemctl-state');out(u.state);}if(a[2]==='--property=MainPID'){fail('systemctl-pid');out(String(u.pid));}}\nif(bin==='systemctl'&&JSON.stringify(a)===JSON.stringify(['--user','list-units','--all','--plain','--no-legend','acp-bridge-*.service','acp-ui-bridge-host@*.service']))out(f.extraUnits.join('\\n'));\nif(bin==='ss'&&JSON.stringify(a)===JSON.stringify(['-H','-ltnp'])){fail('ss');out(f.listeners.join('\\n'));}\nprocess.stderr.write('UNEXPECTED COMMAND '+bin+' '+JSON.stringify(a));process.exit(99);\n`;
    for (const cmd of ['docker','systemctl','ss']) await writeFile(path.join(bin,cmd),fake,{mode:0o755});
    const result = await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[process.env.TEST_CONTROLLER || path.join(ROOT,'scripts/acp-bridges.mjs'),'status'],{env:{...process.env,HOME:dir,PATH:bin,ACP_BRIDGE_MODE_FILE:path.join(dir,'selected'),ACP_BRIDGE_LOCK_DIR:path.join(dir,'locks'),ACP_BRIDGE_PROC_ROOT:procRoot},stdio:['ignore','pipe','pipe']});
      let output=''; child.stdout.on('data',c=>{output+=c});child.stderr.on('data',c=>{output+=c}); child.once('error',reject);child.once('close',code=>resolve({code,output}));
    });
    try {
      assert.doesNotMatch(result.output,/UNEXPECTED COMMAND/,result.output);
      if(expected) { assert.notEqual(result.code,0,`status accepted unsafe ${name}\n${result.output}`); assert.match(result.output,expected); }
      else assert.equal(result.code,0,result.output);
      console.log(`PASS inventory ${name}`);
    } catch (e) { failed++; console.error(`FAIL inventory ${name}: ${e.message}`); }
  }
} finally { await rm(temp,{recursive:true,force:true}); }
if(failed) process.exitCode=1;
