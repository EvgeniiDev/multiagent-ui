#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertBridgeMode, readBridgeMode, writeBridgeMode, DEFAULT_MODE_FILE } from '../deploy/bridge-mode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_ROOT = path.join(os.homedir(), 'projects', 'acp-ui');
const MODE_DIR = path.dirname(DEFAULT_MODE_FILE);
const LOCK_FILE = path.join(MODE_DIR, 'controller.lock');
const BRIDGE_LOCK_DIR = process.env.ACP_BRIDGE_LOCK_DIR || path.join(MODE_DIR, 'locks');
const PROJECT = 'acp-ui';
const BRIDGES = [
  { name: 'hermes', service: 'bridge-hermes', port: 25901, unit: 'acp-ui-bridge-host@hermes.service' },
  { name: 'opencode', service: 'bridge-opencode', port: 25902, unit: 'acp-ui-bridge-host@opencode.service' },
  { name: 'devin', service: 'bridge-devin', port: 25903, unit: 'acp-ui-bridge-host@devin.service' },
  { name: 'pi', service: 'bridge-pi', port: 25904, unit: 'acp-ui-bridge-host@pi.service' },
  { name: 'codex', service: 'bridge-codex', port: 25907, unit: 'acp-ui-bridge-host@codex.service' },
];
const SERVICES = BRIDGES.map((b) => b.service);
const UNITS = BRIDGES.map((b) => b.unit);
export { BRIDGES, UNITS };
const LEGACY_UNITS = BRIDGES.map((b) => `acp-bridge-${b.name}.service`);
export function hostBridgesToInspect(bridges, startingBridge = '') {
  return bridges.filter((bridge) => bridge.name !== startingBridge);
}
export function shouldSkipHostUnitForInventory(state, pid, legacy = false, allowActivating = false) {
  const activeState = String(state).trim();
  if (activeState === 'inactive' && pid === 0) return true;
  return !legacy && allowActivating && activeState === 'activating' && Number.isSafeInteger(pid) && pid > 0;
}
let controllerLockKeeper = null;

function assertControllerLock() {
  if (controllerLockKeeper && controllerLockKeeper.exitCode !== null) {
    throw new Error('bridge mode controller lock keeper exited unexpectedly; aborting transition');
  }
}


function run(bin, args, { cwd = ROOT, quiet = false, env = process.env } = {}) {
  assertControllerLock();
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', env });
  if (result.error) throw result.error;
  assertControllerLock();
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return quiet ? result.stdout.trim() : result.stdout;
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const flags = new Set();
  let mode = '';
  let bridge = '';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--mode') {
      mode = rest[++i] || '';
      if (!mode) throw new Error('--mode requires docker or host');
    } else if (rest[i] === '--bridge') {
      bridge = rest[++i] || '';
      if (!bridge) throw new Error('--bridge requires a bridge name');
    } else if (rest[i] === '--accept-interruption') flags.add(rest[i]);
    else throw new Error(`unknown option: ${rest[i]}`);
  }
  return { action, mode, bridge, flags };
}

function assertCanonicalCheckout() {
  if (ROOT !== CANONICAL_ROOT) throw new Error(`lifecycle commands must run from canonical checkout ${CANONICAL_ROOT}; current checkout is ${ROOT}`);
}

function help() {
  console.log(`ACP bridge mode controller (only Hermes/OpenCode/Devin/Pi/Codex)\n\nUsage:\n  scripts/acp-bridges.mjs status\n  scripts/acp-bridges.mjs preflight --mode docker|host\n  scripts/acp-bridges.mjs guard-start --mode docker|host --bridge <name>\n  scripts/acp-bridges.mjs switch --mode docker|host [--accept-interruption]\n  scripts/acp-bridges.mjs reconcile\n\nDocker is the fresh-install default. A host switch prebuilds and normalizes legacy Docker launches one bridge at a time before handoff. A switch that would stop live bridges requires --accept-interruption; it never falls back to the other mode.`);
}

// Inventory is evidence, never a cleanup instruction. Keep unknown records
// and failed observations so status and lifecycle gates share the same refusal.
const OTHER_SERVICES = new Set(['web', 'state', 'runner', 'https-front', 'stt', 'cron', 'env-controller', 'egress-gw']);
function query(errors, bin, args) {
  try { return run(bin, args); }
  catch (error) { errors.push(error.message); return null; }
}
async function dockerOwners(errors) {
  const output = query(errors, 'docker', ['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.service"}}']);
  const owners = [];
  for (const line of (output || '').split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\t');
    const [id, container, service] = fields;
    const bridge = BRIDGES.find((item) => item.service === service);
    if (fields.length !== 3 || !id || !container || !service || (!bridge && !OTHER_SERVICES.has(service)) ||
        container !== `${PROJECT}-${service}-1`) {
      errors.push(`unknown or ambiguous project container: ${container || '(missing name)'} service=${service || '(missing label)'} id=${id || '(missing id)'}`);
    }
    // Preserve even unrelated/unknown project containers; only known bridge
    // records can be used as lifecycle targets after the inventory passes.
    const owner = { ...bridge, id, container, service };
    owners.push(owner);
    if (!bridge) continue;
    const detail = query(errors, 'docker', ['inspect', '--format', '{{.State.Pid}}\t{{.HostConfig.NetworkMode}}\t{{json .Config.Cmd}}', id]);
    if (detail === null) continue;
    const [pid, network, rawCommand] = detail.trim().split('\t');
    owner.pid = Number(pid);
    let argv;
    try { argv = JSON.parse(rawCommand); } catch { /* rejected below */ }
    const launcherForm = Array.isArray(argv) && argv[0] === '/repo/deploy/acp-bridge-launcher.sh';
    const directLegacyForm = Array.isArray(argv) && argv[0] === 'node';
    const portIndex = Array.isArray(argv) ? argv.indexOf('--port') : -1;
    const commandValid = launcherForm
      ? argv[1] === bridge.name && path.basename(argv[2] || '') === 'node' && String(argv[3] || '').endsWith('/deploy/acp-ws-bridge.mjs')
      : directLegacyForm && String(argv[1] || '').endsWith('/deploy/acp-ws-bridge.mjs');
    owner.modeGuarded = launcherForm;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || network !== 'host' ||
        !commandValid || portIndex < 0 || argv.filter((v) => v === '--port').length !== 1 || argv[portIndex + 1] !== String(bridge.port)) {
      errors.push(`unresolved Docker bridge process/configured port identity: ${container} expected :${bridge.port}`);
    }
  }
  return owners;
}
async function unitOwners(bridges, errors, legacy = false, allowActivating = false) {
  const owners = [];
  for (const bridge of bridges) {
    const unit = legacy ? bridge : bridge.unit;
    const state = query(errors, 'systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit]);
    const rawPid = query(errors, 'systemctl', ['--user', 'show', '--property=MainPID', '--value', unit]);
    const pid = /^\d+$/.test(rawPid?.trim() || '') ? Number(rawPid.trim()) : NaN;
    if (state === null || rawPid === null) continue;
    if (!Number.isSafeInteger(pid) || pid < 0) errors.push(`unresolved MainPID for ${unit}`);
    // Peer systemd start jobs run in parallel in host mode; ss below rejects any pending peer that has already bound a bridge port.
    if (shouldSkipHostUnitForInventory(state, pid, legacy, allowActivating)) continue;
    if (state.trim() !== 'active') errors.push(`unresolved systemd owner ${unit}: state=${state.trim() || '(empty state)'} MainPID=${pid}`);
    if (legacy) { owners.push(unit); continue; }
    if (pid <= 0) errors.push(`unresolved MainPID for ${unit}`);
    owners.push({ ...bridge, pid });
  }
  return owners;
}
async function verifyDockerSocket(owner, errors) {
  const script = `const fs=require('node:fs');const port=${owner.port};const argv=fs.readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean);const listeners=new Set();for(const file of ['/proc/net/tcp','/proc/net/tcp6']){for(const row of fs.readFileSync(file,'utf8').trim().split(/\\r?\\n/).slice(1)){const c=row.trim().split(/\\s+/);if(c[3]==='0A'&&parseInt(c[1].split(':').at(-1),16)===port)listeners.add(c[9]);}}const owned=[];for(const fd of fs.readdirSync('/proc/1/fd')){try{const m=fs.readlinkSync('/proc/1/fd/'+fd).match(/^socket:\\[(\\d+)\\]$/);if(m&&listeners.has(m[1]))owned.push(m[1]);}catch{}}process.stdout.write(JSON.stringify({argv,listeners:[...listeners],inodes:[...new Set(owned)]}));`;
  let output;
  try { output = run('docker', ['exec', owner.container, 'node', '-e', script]); }
  catch { errors.push(`Docker PID 1 socket proof failed for ${owner.name} expected :${owner.port}`); return false; }
  let proof;
  try { proof = JSON.parse(output); } catch { /* rejected below */ }
  const argv = proof?.argv;
  const portIndex = Array.isArray(argv) ? argv.indexOf('--port') : -1;
  if (!Array.isArray(argv) || path.basename(argv[0] || '') !== 'node' ||
      !String(argv[1] || '').endsWith('/deploy/acp-ws-bridge.mjs') ||
      portIndex < 0 || argv.filter((v) => v === '--port').length !== 1 || argv[portIndex + 1] !== String(owner.port) ||
      !Array.isArray(proof.inodes) || proof.inodes.length !== 1 || !/^\d+$/.test(proof.inodes[0]) ||
      !Array.isArray(proof.listeners) || proof.listeners.length !== 1 || proof.listeners[0] !== proof.inodes[0]) {
    errors.push(`invalid Docker PID 1 socket proof for ${owner.name} expected :${owner.port}`);
    return false;
  }
  return true;
}
async function verifyDockerSockets(owners, ports, errors) {
  for (const owner of owners) {
    const rows = ports.get(owner.port) || [];
    if (!rows.length || rows.some((row) => row.pids.length)) continue;
    if (rows.length !== 1) {
      errors.push(`ambiguous Docker listener rows for ${owner.name} :${owner.port}`);
      continue;
    }
    owner.socketProof = await verifyDockerSocket(owner, errors);
  }
}
async function verifyBridgeProcesses(owners, errors) {
  const procRoot = process.env.ACP_BRIDGE_PROC_ROOT || '/proc';
  for (const owner of owners) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
    let argv;
    try { argv = (await readFile(path.join(procRoot, String(owner.pid), 'cmdline'), 'utf8')).split('\0').filter(Boolean); }
    catch { errors.push(`unresolved bridge process ${owner.name} PID=${owner.pid} expected :${owner.port}`); continue; }
    const portIndex = argv.indexOf('--port');
    if (path.basename(argv[0] || '') !== 'node' || !String(argv[1] || '').endsWith('/deploy/acp-ws-bridge.mjs') ||
        portIndex < 0 || argv.filter((v) => v === '--port').length !== 1 || argv[portIndex + 1] !== String(owner.port)) {
      // Never print process argv: unrelated processes may carry credentials.
      errors.push(`wrong bridge process identity ${owner.name} PID=${owner.pid} expected :${owner.port}`);
    }
  }
}
function unknownUnits(errors) {
  const output = query(errors, 'systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', 'acp-bridge-*.service', 'acp-ui-bridge-host@*.service']);
  for (const line of (output || '').split(/\r?\n/).filter(Boolean)) {
    const unit = line.trim().split(/\s+/)[0];
    if (![...LEGACY_UNITS, ...UNITS].includes(unit)) errors.push(`unknown bridge unit: ${unit}`);
  }
}
function listeningPorts(errors) {
  const throwOnError = !errors;
  errors ||= [];
  const priorErrors = errors.length;
  const output = query(errors, 'ss', ['-H', '-ltnp']);
  const found = new Map();
  for (const line of (output || '').split(/\r?\n/).filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[3] || '';
    const match = local.match(/:(\d+)$/);
    if (!match) { errors.push(`unparseable listener row: ${line}`); continue; }
    const port = Number(match[1]);
    const pids = [...new Set([...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
    const rows = found.get(port) || [];
    rows.push({ local, pids, description: `${local} ${fields.slice(5).join(' ') || 'process owner unavailable'}` });
    found.set(port, rows);
  }
  // Query failure must never become an empty successful port-free check.
  if (output === null || (throwOnError && errors.length > priorErrors)) throw new Error(errors.at(-1));
  return found;
}
const describeListeners = (rows) => rows?.map((r) => r.description).join('; ') || 'no listener';
async function observe({ startingHostBridge = '' } = {}) {
  const errors = [];
  const mode = await readBridgeMode({ allowMissing: false });
  const projectContainers = await dockerOwners(errors);
  const docker = projectContainers.filter((owner) => owner.name);
  const host = await unitOwners(hostBridgesToInspect(BRIDGES, startingHostBridge), errors, false, mode === 'host');
  const legacy = await unitOwners(LEGACY_UNITS, errors, true);
  unknownUnits(errors);
  await verifyBridgeProcesses([...docker, ...host], errors);
  const ports = listeningPorts(errors);
  await verifyDockerSockets(docker, ports, errors);
  return { mode, docker, projectContainers, host, legacy, ports, errors };
}
function ownershipErrors(state) {
  const errors = [...state.errors];
  if (state.legacy.length) errors.push(`legacy bridge units active: ${state.legacy.join(', ')}`);
  const dockerBridges = state.docker.filter((o) => o.name);
  if (dockerBridges.length && state.host.length) errors.push('Docker and host bridge sets are both active; refusing automated cleanup');
  if ((state.mode === 'host' && dockerBridges.length) || (state.mode === 'docker' && state.host.length)) errors.push(`owners disagree with selected mode ${state.mode}`);
  const allPids = new Set();
  for (const bridge of BRIDGES) {
    const owners = [...dockerBridges.filter((o) => o.name === bridge.name), ...state.host.filter((o) => o.name === bridge.name)];
    const rows = state.ports.get(bridge.port) || [];
    if (owners.length > 1) errors.push(`duplicate owners for ${bridge.name} :${bridge.port}`);
    if (owners.length && !rows.length) errors.push(`owner ${bridge.name} missing listener :${bridge.port}`);
    if (!owners.length && rows.length) errors.push(`unowned listener :${bridge.port}: ${describeListeners(rows)}`);
    const endpoints = new Set();
    for (const row of rows) {
      if (endpoints.has(row.local)) errors.push(`duplicate listener endpoint :${bridge.port}: ${row.local}`);
      endpoints.add(row.local);
      const dockerWithoutPidProof = owners.length === 1 && owners[0].service?.startsWith('bridge-') && owners[0].socketProof === true;
      const matchesPid = row.pids.length === 1 && row.pids[0] === owners[0]?.pid;
      const matchesDockerProof = row.pids.length === 0 && dockerWithoutPidProof;
      if (owners.length !== 1 || (!matchesPid && !matchesDockerProof)) {
        errors.push(`unresolved bridge-to-listener identity ${bridge.name} :${bridge.port}: ${row.description}`);
      }
    }
    for (const owner of owners) {
      if (owner.pid && allPids.has(owner.pid)) errors.push(`duplicate bridge process PID ${owner.pid} for ${bridge.name}`);
      allPids.add(owner.pid);
    }
  }
  return errors;
}
function printStatus(state) {
  console.log(`selected mode: ${state.mode}`);
  for (const bridge of BRIDGES) {
    const docker = state.docker.filter((item) => item.service === bridge.service);
    const hostActive = state.host.some((item) => item.name === bridge.name);
    console.log(`${bridge.name} :${bridge.port} — docker=${docker.map((item) => item.container).join(',') || 'off'} host=${hostActive ? 'active' : 'off'} ${describeListeners(state.ports.get(bridge.port))}`);
  }
  for (const owner of state.projectContainers.filter((o) => !o.name)) console.log(`project container: ${owner.container} service=${owner.service || '(missing label)'}`);
  const errors = ownershipErrors(state);
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (errors.length) process.exitCode = 1;
}

async function preflight(mode) {
  if (!['docker', 'host'].includes(mode)) throw new Error('mode must be exactly docker or host');
  await verifyBridgeLockFiles();
  if (mode === 'docker') {
    await access(path.join(ROOT, 'compose.yaml'), constants.R_OK);
    run('docker', ['compose', '-p', PROJECT, '-f', 'compose.yaml', 'config', '--quiet']);
    console.log('PASS Docker Compose configuration parses; no services were started.');
    return;
  }
  for (const name of ['hermes', 'opencode', 'devin', 'pi', 'pi-acp', 'codex']) {
    const pathValue = run('sh', ['-lc', `command -v ${name}`], { quiet: true });
    console.log(`${name}: ${pathValue}`);
  }
  const probes = [
    ['hermes', ['--version']], ['opencode', ['--version']], ['devin', ['--version']],
    ['pi', ['--version']], ['codex', ['--version']],
  ];
  const versions = new Map();
  for (const [name, args] of probes) {
    const version = run(name, args, { quiet: true }).split(/\r?\n/)[0];
    versions.set(name, version);
    console.log(`${name}: ${version}`);
  }
  console.log(`node: ${process.version}`);
  run(process.execPath, ['-e', "require.resolve('ws')"], {
    quiet: true,
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '/home/hermes/.local/lib/node_modules' },
  });
  const piPackage = '/home/hermes/.local/lib/node_modules/pi-acp';
  const pkg = JSON.parse(await readFile(path.join(piPackage, 'package.json'), 'utf8'));
  if (pkg.version !== '0.0.33') throw new Error(`host pi-acp must be pinned to 0.0.33 (found package=${pkg.version})`);
  const dist = await readFile(path.join(piPackage, 'dist/index.js'), 'utf8');
  if (!dist.includes('acp-ui shared bridge: retain independent Pi sessions (v2)')) {
    throw new Error('host pi-acp lacks the required multisession patch; run the documented host provisioning step');
  }
  if (!versions.get('pi').includes('0.85.1')) {
    throw new Error(`host pi must match Docker-pinned 0.85.1 (found ${versions.get('pi')})`);
  }
  console.log(`PASS host CLI preflight; Pi ${versions.get('pi')}, pi-acp ${pkg.version} patched; running as ${process.env.USER || 'unknown'} with host filesystem access.`);
}

async function verifyBridgeLockFiles() {
  try { await access('/usr/bin/flock', 1); }
  catch { throw new Error('required lock utility missing: /usr/bin/flock (install util-linux)'); }
  if (!path.isAbsolute(BRIDGE_LOCK_DIR)) throw new Error(`bridge lock directory must be absolute: ${BRIDGE_LOCK_DIR}`);
  const uid = process.getuid();
  const gid = process.getgid();
  let dir;
  try { dir = await lstat(BRIDGE_LOCK_DIR); }
  catch (error) { throw new Error(`bridge lock directory is missing at ${BRIDGE_LOCK_DIR}; run deploy/install.sh first (${error.message})`); }
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || dir.gid !== gid || (dir.mode & 0o7777) !== 0o2770) {
    throw new Error(`unsafe bridge lock directory ${BRIDGE_LOCK_DIR}: expected owned by ${uid}:${gid}, mode 2770, real directory`);
  }
  const resolvedLockDir = await realpath(BRIDGE_LOCK_DIR);
  if (resolvedLockDir !== path.resolve(BRIDGE_LOCK_DIR)) throw new Error(`bridge lock directory has a symlink/alias path: ${BRIDGE_LOCK_DIR}`);
  for (const bridge of BRIDGES) {
    const file = path.join(BRIDGE_LOCK_DIR, `${bridge.name}.lock`);
    let stat;
    try { stat = await lstat(file); }
    catch (error) { throw new Error(`bridge lock file missing at ${file}; run deploy/install.sh first (${error.message})`); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== 0o660) {
      throw new Error(`unsafe bridge lock file ${file}: expected owned by ${uid}:${gid}, mode 0660, regular non-symlink file`);
    }
  }
}

export async function startMode(mode) {
  await assertBridgeMode(mode);
  if (mode === 'docker') run('docker', ['compose', '-p', PROJECT, '-f', 'compose.yaml', 'up', '-d', '--no-deps', ...SERVICES]);
  // Serialized: one blocking `systemctl --user start <unit>` per bridge, in
  // bridge order. A single parallel start would leave peers `activating`
  // with MainPID=0, which the direct-start inventory gate fails closed on —
  // never create that state from the controller itself.
  else for (const unit of UNITS) run('systemctl', ['--user', 'start', unit]);
}

async function stopMode(mode, state) {
  if (mode === 'docker') {
    const ids = state.docker.map((item) => item.id);
    if (ids.length) run('docker', ['stop', '--time', '30', ...ids]);
  } else {
    const active = state.host.map((item) => item.unit);
    if (active.length) run('systemctl', ['--user', 'stop', ...active]);
  }
}

async function waitForBridgePortFree(bridge) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ports = listeningPorts();
    const rows = ports.get(bridge.port) || [];
    if (!rows.length) return;
    if (attempt === 39) {
      throw new Error(`port ${bridge.port} remains occupied after stopping ${bridge.name}: ${describeListeners(rows)}; no listener was killed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function isTransientDockerBridgeStartupError(error, bridge) {
  const name = bridge.name;
  const port = bridge.port;
  return new RegExp(`^(?:unresolved bridge process ${name} PID=\\d+ expected :${port}|wrong bridge process identity ${name} PID=\\d+ expected :${port}|Docker PID 1 socket proof failed for ${name} expected :${port}|invalid Docker PID 1 socket proof for ${name} expected :${port})$`).test(String(error));
}

async function waitForGuardedDockerBridge(bridge) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await observe();
    const transient = state.errors.length > 0 && state.errors.every((error) => isTransientDockerBridgeStartupError(error, bridge));
    if (state.errors.length && !transient) throw new Error(`Docker normalization inventory failed: ${state.errors.join('; ')}`);
    const owner = state.docker.find((item) => item.name === bridge.name);
    const rows = state.ports.get(bridge.port) || [];
    if (transient || (!owner && !rows.length) || (owner && owner.modeGuarded && !rows.length)) {
      if (attempt === 39) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (!owner || !owner.modeGuarded || !rows.length) {
      throw new Error(`Docker normalization produced an unresolved owner/listener for ${bridge.name} :${bridge.port}`);
    }
    assertNoMixedOwners(state);
    return;
  }
  throw new Error(`guarded Docker bridge ${bridge.name} did not become ready on :${bridge.port}; no fallback attempted`);
}

export async function normalizeDockerOwners(owners, actions) {
  const plan = [];
  for (const bridge of BRIDGES) {
    const matching = owners.filter((owner) => owner.name === bridge.name);
    if (!matching.length) continue;
    if (matching.length !== 1) throw new Error(`invalid Docker owner identity for ${bridge.name}`);
    const owner = matching[0];
    if (owner.modeGuarded === true) continue;
    if (owner.modeGuarded !== false || owner.id === undefined || owner.id === '' ||
        owner.service !== bridge.service || owner.container !== `${PROJECT}-${bridge.service}-1`) {
      throw new Error(`invalid Docker owner identity for ${bridge.name}`);
    }
    plan.push({ bridge, owner });
  }
  if (plan.length) {
    if (typeof actions.prepare !== 'function') throw new Error('Docker normalization requires an image preparation step');
    await actions.prepare();
  }
  for (const { bridge, owner } of plan) {
    await actions.stop(owner);
    await actions.waitPortFree(bridge);
    await actions.start(bridge);
    await actions.verify(bridge);
  }
  return true;
}

export async function normalizeDockerForHost(owners) {
  return normalizeDockerOwners(owners, {
    prepare: () => run('docker', ['compose', '-p', PROJECT, '-f', 'compose.yaml', 'build', ...SERVICES]),
    stop: (owner) => run('docker', ['stop', '--time', '30', owner.id]),
    waitPortFree: waitForBridgePortFree,
    start: (bridge) => run('docker', ['compose', '-p', PROJECT, '-f', 'compose.yaml', 'up', '-d', '--no-deps', bridge.service]),
    verify: waitForGuardedDockerBridge,
  });
}

function assertNoMixedOwners(state) {
  const errors = ownershipErrors(state);
  if (errors.length) throw new Error(`unsafe ownership inventory: ${errors.join('; ')}`);
}

export function assertBridgeStartAllowed(mode, bridgeName, state) {
  if (!['docker', 'host'].includes(mode)) throw new Error('mode must be exactly docker or host');
  const bridge = BRIDGES.find((item) => item.name === bridgeName);
  if (!bridge) throw new Error(`unknown bridge name: ${bridgeName}`);
  if (state.mode !== mode) throw new Error(`selected mode is ${state.mode}; refusing to start ${mode} bridge`);
  assertNoMixedOwners(state);
  const currentOwners = mode === 'docker' ? state.docker : state.host;
  if (currentOwners.some((owner) => owner.name === bridgeName)) {
    throw new Error(`${mode} owner for ${bridgeName} already exists on :${bridge.port}`);
  }
  return true;
}

async function waitForPortsFree() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ports = listeningPorts();
    const conflicts = BRIDGES.filter((bridge) => ports.has(bridge.port));
    if (!conflicts.length) return;
    if (attempt === 39) throw new Error(`ports still occupied after stopping selected bridges: ${conflicts.map((item) => `${item.name}:${item.port} by ${describeListeners(ports.get(item.port))}`).join(', ')}; no listener was killed`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function verifyTarget(mode) {
  const state = await observe();
  assertNoMixedOwners(state);
  const active = mode === 'docker' ? state.docker : state.host;
  if (active.length !== BRIDGES.length) throw new Error(`target mode ${mode} owns ${active.length}/${BRIDGES.length} bridge services; selected mode remains ${mode}`);
  const missingPorts = BRIDGES.filter((item) => !state.ports.has(item.port));
  if (missingPorts.length) throw new Error(`target mode active but listener missing on ${missingPorts.map((item) => item.port).join(', ')}`);
  console.log(`PASS all five ${mode} bridges own their expected listeners.`);
}

async function waitForTarget(mode) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await observe();
    assertNoMixedOwners(state);
    const active = mode === 'docker' ? state.docker : state.host;
    const opposite = mode === 'docker' ? state.host : state.docker;
    if (opposite.length) throw new Error(`opposite ${mode === 'docker' ? 'host' : 'docker'} owners appeared during startup; refusing fallback`);
    if (active.length === BRIDGES.length && BRIDGES.every((bridge) => state.ports.has(bridge.port))) return verifyTarget(mode);
    if (attempt === 39) throw new Error(`target ${mode} did not become ready: ${active.length}/${BRIDGES.length} owners; ports=${BRIDGES.map((bridge) => `${bridge.port}:${describeListeners(state.ports.get(bridge.port))}`).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function reconcile() {
  assertCanonicalCheckout();
  const desired = await readBridgeMode();
  const state = await observe();
  assertNoMixedOwners(state);
  const oppositeActive = desired === 'docker' ? state.host.length > 0 : state.docker.length > 0;
  if (oppositeActive) throw new Error(`desired mode is ${desired}, but the other mode still owns bridges; use switch with explicit interruption consent`);
  const current = desired === 'docker' ? state.docker.length : state.host.length;
  if (current === BRIDGES.length) return verifyTarget(desired);
  if (current > 0) throw new Error(`only ${current}/${BRIDGES.length} ${desired} bridges are active; refusing implicit partial restart`);
  await preflight(desired);
  await startMode(desired);
  await waitForTarget(desired);
}

async function switchMode(target, acceptInterruption) {
  assertCanonicalCheckout();
  if (!['docker', 'host'].includes(target)) throw new Error('switch requires --mode docker or --mode host');
  await preflight(target);
  let state = await observe();
  assertNoMixedOwners(state);
  const runningMode = state.docker.length ? 'docker' : state.host.length ? 'host' : '';
  const targetCount = target === 'docker' ? state.docker.length : state.host.length;
  if (runningMode === target && targetCount === BRIDGES.length) {
    await writeBridgeMode(target);
    await verifyTarget(target);
    console.log(`Already running in ${target} mode.`);
    return;
  }
  if (runningMode && !acceptInterruption) {
    throw new Error(`stopping the active ${runningMode} bridges interrupts their sessions; close/drain work and repeat with --accept-interruption`);
  }
  if (target === 'host' && runningMode === 'docker') {
    console.log('Normalizing Docker bridge launch guards one bridge at a time before host handoff.');
    await normalizeDockerForHost(state.docker);
    state = await observe();
    assertNoMixedOwners(state);
    const unguarded = state.docker.filter((owner) => owner.modeGuarded !== true);
    if (unguarded.length) throw new Error(`refusing host switch with unguarded Docker bridge owners: ${unguarded.map((owner) => owner.name).join(', ')}`);
  }
  if (runningMode) await stopMode(runningMode, state);
  await waitForPortsFree();
  await writeBridgeMode(target);
  await startMode(target);
  await waitForTarget(target);
}

async function withLock(operation) {
  const marker = 'ACP_BRIDGE_CONTROLLER_LOCK_READY';
  const parentStat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const parentStart = parentStat.slice(parentStat.lastIndexOf(')') + 2).split(' ')[19];
  if (!parentStart) throw new Error('cannot identify controller process start time for lock keeper');
  const keeperCode = `const fs=require('node:fs');const p=${process.pid};const s='${parentStart}';const check=()=>{try{const raw=fs.readFileSync('/proc/'+p+'/stat','utf8');const v=raw.slice(raw.lastIndexOf(')')+2).split(' ')[19];if(v!==s)process.exit(0)}catch{process.exit(0)}};setInterval(check,250);process.stdout.write('${marker}');`;
  const child = spawn('/usr/bin/flock', ['--no-fork', '--nonblock', '--conflict-exit-code', '75', LOCK_FILE,
    process.execPath, '-e', keeperCode], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const keeper = await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('timed out acquiring bridge mode controller lock'));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      if (settled || !chunk.toString().includes(marker)) return;
      settled = true;
      clearTimeout(timeout);
      resolve(child);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(code === 75 ? 'another bridge mode operation holds the controller lock' :
        `controller lock keeper exited before acquisition (code=${code}, signal=${signal})${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
  controllerLockKeeper = keeper;
  try {
    assertControllerLock();
    const result = await operation();
    assertControllerLock();
    return result;
  } finally {
    if (keeper.exitCode === null && keeper.signalCode === null) keeper.kill('SIGTERM');
    if (keeper.exitCode === null && keeper.signalCode === null) await new Promise((resolve) => keeper.once('close', resolve));
    controllerLockKeeper = null;
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.action === 'help' || parsed.action === '--help' || !parsed.action) return help();
  if (parsed.action === 'status') return printStatus(await observe());
  if (parsed.action === 'preflight') return preflight(parsed.mode);
  if (parsed.action === 'guard-start') {
    assertCanonicalCheckout();
    const state = await observe({ startingHostBridge: parsed.mode === 'host' ? parsed.bridge : '' });
    assertBridgeStartAllowed(parsed.mode, parsed.bridge, state);
    console.log(`PASS ${parsed.mode} start gate for ${parsed.bridge}; selected mode and live ownership agree.`);
    return;
  }
  if (!['switch', 'reconcile'].includes(parsed.action)) throw new Error(`unknown action: ${parsed.action}`);
  assertCanonicalCheckout();
  await mkdir(MODE_DIR, { recursive: true, mode: 0o700 });
  if (parsed.action === 'switch') {
    return withLock(() => switchMode(parsed.mode, parsed.flags.has('--accept-interruption')));
  }
  return withLock(() => reconcile());
}

export { withLock };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`acp-bridges: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
