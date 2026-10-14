import assert from 'node:assert/strict';
import { assertBridgeStartAllowed, hostBridgesToInspect, shouldSkipHostUnitForInventory } from './acp-bridges.mjs';

const listener = (port, pid) => ({ local: `*:${port}`, pids: [pid], description: `*:${port} pid=${pid}` });
const dockerOwner = { name: 'hermes', service: 'bridge-hermes', container: 'acp-ui-bridge-hermes-1', port: 25901, pid: 1234 };
const state = (mode, docker = [], host = [], errors = []) => ({
  mode, docker, host, legacy: [], errors,
  projectContainers: docker,
  ports: new Map([...docker, ...host].map((owner) => [owner.port, [listener(owner.port, owner.pid)]])),
});

assert.deepEqual(hostBridgesToInspect([{ name: 'hermes' }, { name: 'pi' }], 'hermes'), [{ name: 'pi' }],
  'a systemd ExecStartPre inspection must exclude its own activating unit, then let listener ownership detect an already-bound port');
assert.equal(shouldSkipHostUnitForInventory('activating', 0), false,
  'activating host units are not ignorable while Docker mode is selected');
assert.equal(shouldSkipHostUnitForInventory('activating', 1234), false,
  'a pending host unit is unsafe in Docker mode');
assert.equal(shouldSkipHostUnitForInventory('activating', 1234, false, true), true,
  'peer host units may be pending during host-mode parallel startup; listener inventory decides ownership');
assert.equal(shouldSkipHostUnitForInventory('activating', 0, false, true), false,
  'host-mode activating without a live MainPID stays fail-closed; listener inventory decides ownership');
assert.equal(shouldSkipHostUnitForInventory('failed', 0, false, true), false, 'failed units remain errors');
assert.equal(shouldSkipHostUnitForInventory('activating', Number.NaN, false, true), false, 'unreadable MainPID remains an error');
assert.equal(shouldSkipHostUnitForInventory('activating', 1234, true, true), false, 'legacy units never become ignorable pending owners');
assert.throws(() => assertBridgeStartAllowed('host', 'hermes', state('docker')), /selected mode is docker/);
assert.throws(() => assertBridgeStartAllowed('host', 'hermes', state('host', [dockerOwner])), /Docker|owners disagree|unsafe/i,
  'host unit must refuse a Docker owner even when that owner does not hold the new shared flock');
assert.throws(() => assertBridgeStartAllowed('host', 'hermes', state('host', [], [], ['cannot inspect Docker ownership'])), /cannot inspect Docker ownership/,
  'unknown inventory state must fail closed');
const pendingPeerWithListener = { ...state('host'), ports: new Map([[25902, [listener(25902, 5678)]]]) };
assert.throws(() => assertBridgeStartAllowed('host', 'hermes', pendingPeerWithListener), /unowned listener/,
  'a pending peer can be ignored only until it binds; its listener must still fail closed without an active owner');
assert.equal(assertBridgeStartAllowed('host', 'hermes', state('host')), true,
  'host unit may start when host mode is selected and the port has no owner');
const existingHost = { ...dockerOwner, unit: 'acp-ui-bridge-host@hermes.service' };
assert.throws(() => assertBridgeStartAllowed('host', 'hermes', state('host', [], [existingHost])), /already|duplicate|owner/i);
console.log('PASS host direct-start gate enforces selected mode and current ownership independently of shared flock');
