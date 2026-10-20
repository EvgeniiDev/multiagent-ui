import assert from 'node:assert/strict';
import { recoverHostStarts } from './acp-bridges.mjs';

const bridges = ['hermes', 'opencode', 'devin', 'pi', 'codex'].map((name, i) => ({ name, unit: `${name}.service`, port: 25901 + i }));
async function scenario({ mode = 'host', conflict = false, failStart = false, changedPid = false } = {}) {
  const calls = [];
  let reads = 0;
  const units = bridges.map((b, i) => ({ ...b, state: i < 3 ? 'activating' : 'active', pid: i < 3 ? 0 : 100 + i }));
  const actions = {
    mode,
    readUnits: async () => { reads++; return units.map(u => ({ ...u, pid: changedPid && reads > 1 && u.name === 'devin' ? 999 : u.pid })); },
    inspect: async excluded => { calls.push(['inspect', excluded]); if (conflict) throw new Error('unowned listener :25903'); },
    stop: async names => { calls.push(['stop', names]); },
    preflight: async () => { calls.push(['preflight']); },
    start: async unit => { calls.push(['start', unit]); if (failStart) throw new Error('start failed'); },
    ready: async bridge => { calls.push(['ready', bridge.name]); },
  };
  return { calls, run: () => recoverHostStarts(actions) };
}
const ok = await scenario();
await ok.run();
assert.deepEqual(ok.calls, [
  ['inspect', ['hermes', 'opencode', 'devin']], ['preflight'],
  ['stop', ['hermes.service', 'opencode.service', 'devin.service']], ['inspect', []],
  ['start', 'hermes.service'], ['ready', 'hermes'],
  ['start', 'opencode.service'], ['ready', 'opencode'],
  ['start', 'devin.service'], ['ready', 'devin'],
]);
for (const [options, error] of [[{ mode: 'docker' }, /host/], [{ conflict: true }, /unowned listener/], [{ changedPid: true }, /changed/]]) {
  const s = await scenario(options);
  await assert.rejects(s.run, error);
  assert.ok(!s.calls.some(c => c[0] === 'stop' || c[0] === 'start'), 'unsafe inventory must not change services');
}
const failed = await scenario({ failStart: true });
await assert.rejects(failed.run, /start failed/);
assert.equal(failed.calls.filter(c => c[0] === 'start').length, 1, 'stop after a failed start; no fallback or parallel launch');
console.log('PASS recover parallel pre-start deadlock serially; preserve active bridges; reject conflicts and changed owners');
