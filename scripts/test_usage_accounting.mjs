import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { createPinia, setActivePinia } = await import('pinia');
const { useActivityStore } = await import('../src/stores/activity.ts');
function store(rows) { setActivePinia(createPinia()); const s = useActivityStore(); s.usage = rows; return s; }
const row = (at, used, extras = {}) => ({ at, used, size: 0, sessionId: 'same', agentName: 'OpenCode', ...extras });

test('agents with the same session id are independent', () => {
  const s = store([row(1, 100), row(2, 200, { agentName: 'Devin' })]);
  assert.equal(s.totalUsage(0, 10).tokens, 300);
});
test('context occupancy is not token expenditure', () => {
  const s = store([row(1, 100, { accounting: 'context' }), row(2, 200, { accounting: 'context' })]);
  assert.equal(s.totalUsage(0, 10).tokens, 0);
});
test('legacy Hermes context snapshots are not counted as consumption', () => {
  const s = store([row(1, 100, { agentName: 'Hermes Agent' })]);
  assert.equal(s.totalUsage(0, 10).tokens, 0);
});
test('native per-call records add instead of being treated as running totals', () => {
  const s = store([row(1, 100, { accounting: 'delta' }), row(2, 200, { accounting: 'delta' })]);
  assert.equal(s.totalUsage(0, 10).tokens, 300);
});
test('money is a delta too, with its currency retained', () => {
  const s = store([row(1, 100, { cost: 1, currency: 'USD' }), row(3, 300, { cost: 3, currency: 'USD' })]);
  const r = s.deltaRows(2, 4);
  assert.equal(r.reduce((n, x) => n + x.cost, 0), 2);
  assert.equal(r[0].currency, 'USD');
});
test('model switches attribute each increment to its actual model', () => {
  const s = store([row(1, 100, { model: 'A' }), row(2, 300, { model: 'B' })]);
  assert.deepEqual(s.usageByModel(0, 10).map(x => [x.model, x.tokens]), [['B', 200], ['A', 100]]);
});
test('daily figures match totals for a partial first day', () => {
  const s = store([row(1, 100), row(2, 200), row(86400001, 400)]);
  assert.equal(s.usageByDay(2, 86400002).reduce((n, x) => n + x.tokens, 0), s.totalUsage(2, 86400002).tokens);
});
test('native history replaces the same agents legacy and estimates', async () => {
  const s = store([row(1, 9999), row(2, 9999, { source: 'estimate' }), row(1, 400, { agentName: '/usr/local/bin/pi-acp' })]);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    usage: [row(1, 100, { accounting: 'delta' }), row(2, 200, { accounting: 'delta', agentName: 'Pi' })],
    sources: [{ agentName: 'OpenCode', status: 'ready', samples: 1 }, { agentName: 'Pi', status: 'ready', samples: 1 }, { agentName: 'Devin', status: 'ready', samples: 0 }],
  }));
  try {
    await s.refreshNativeUsage();
    assert.equal(s.totalUsage(0, 10).tokens, 300);
    assert.equal(s.usageByAgent(0, 10).find(r => r.agentName === 'Devin').tokens, 0);
  } finally { globalThis.fetch = original; }
});
test('the same model on different providers has separate totals', () => {
  const s = store([row(1, 100, { model: 'M', provider: 'P1', accounting: 'delta' }), row(2, 200, { model: 'M', provider: 'P2', accounting: 'delta' })]);
  assert.equal(s.usageByModel(0, 10).length, 2);
});
test('token mix buckets follow cumulative deltas', () => {
  const s = store([row(1, 100, { input: 60, cacheRead: 30, output: 10 }),
                   row(2, 250, { input: 160, cacheRead: 70, output: 20 })]);
  const r = s.deltaRows(0, 10);
  assert.equal(r[1].input, 100);
  assert.equal(r[1].cacheRead, 40);
  assert.equal(r[1].output, 10);
});
