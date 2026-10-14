import assert from 'node:assert/strict';
import { BRIDGES, isTransientDockerBridgeStartupError, normalizeDockerOwners } from './acp-bridges.mjs';

assert.equal(isTransientDockerBridgeStartupError('wrong bridge process identity opencode PID=10 expected :25902', BRIDGES[1]), true);
assert.equal(isTransientDockerBridgeStartupError('Docker PID 1 socket proof failed for opencode expected :25902', BRIDGES[1]), true);
assert.equal(isTransientDockerBridgeStartupError('unowned listener :25902: *:25902 pid=99', BRIDGES[1]), false);
assert.equal(isTransientDockerBridgeStartupError('unknown bridge unit: acp-bridge-evil.service', BRIDGES[1]), false);

const owners = BRIDGES.map((bridge, index) => ({
  ...bridge,
  id: `id-${bridge.name}`,
  container: `acp-ui-${bridge.service}-1`,
  modeGuarded: index === 0,
}));
const events = [];
const result = await normalizeDockerOwners(owners, {
  prepare: async () => events.push('build'),
  stop: async (owner) => events.push(`stop:${owner.name}:${owner.id}`),
  waitPortFree: async (bridge) => events.push(`free:${bridge.name}:${bridge.port}`),
  start: async (bridge) => events.push(`compose:${bridge.service}`),
  verify: async (bridge) => events.push(`verified:${bridge.name}`),
});
assert.equal(result, true);
assert.deepEqual(events, ['build', ...BRIDGES.slice(1).flatMap((bridge) => [
  `stop:${bridge.name}:id-${bridge.name}`,
  `free:${bridge.name}:${bridge.port}`,
  `compose:${bridge.service}`,
  `verified:${bridge.name}`,
])]);
await assert.rejects(
  normalizeDockerOwners([{ name: 'opencode', service: 'bridge-opencode', container: 'bad', id: '' }], {
    stop: async () => assert.fail('must reject malformed owner before stop'),
    waitPortFree: async () => assert.fail('must reject malformed owner before wait'),
    start: async () => assert.fail('must reject malformed owner before compose'),
    verify: async () => assert.fail('must reject malformed owner before verify'),
  }),
  /invalid Docker owner identity/i,
);
const absent = await normalizeDockerOwners([], {
  stop: async () => assert.fail('absent owners must be skipped'),
  waitPortFree: async () => assert.fail('absent owners must be skipped'),
  start: async () => assert.fail('absent owners must be skipped'),
  verify: async () => assert.fail('absent owners must be skipped'),
});
assert.equal(absent, true);
const failedEvents = [];
await assert.rejects(
  normalizeDockerOwners([owners[1]], {
    prepare: async () => {},
    stop: async () => failedEvents.push('stopped'),
    waitPortFree: async () => { failedEvents.push('wait'); throw new Error('unknown process still owns port'); },
    start: async () => failedEvents.push('must-not-compose'),
    verify: async () => failedEvents.push('must-not-verify'),
  }),
  /unknown process still owns port/,
);
assert.deepEqual(failedEvents, ['stopped', 'wait'], 'unknown port owner must prevent Compose start');
const buildFailureEvents = [];
await assert.rejects(
  normalizeDockerOwners([owners[1]], {
    prepare: async () => { buildFailureEvents.push('build'); throw new Error('image build failed'); },
    stop: async () => buildFailureEvents.push('must-not-stop'),
    waitPortFree: async () => buildFailureEvents.push('must-not-wait'),
    start: async () => buildFailureEvents.push('must-not-compose'),
    verify: async () => buildFailureEvents.push('must-not-verify'),
  }),
  /image build failed/,
);
assert.deepEqual(buildFailureEvents, ['build'], 'image failure must abort before stopping any bridge');
console.log('PASS Docker normalization stops, frees, recreates, then verifies each known bridge in order');
