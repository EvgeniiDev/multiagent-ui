import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { createPinia, setActivePinia } = await import('pinia');
const { isProxy, watchEffect } = await import('vue');
const { useTrafficStore } = await import('../src/stores/traffic.ts');
beforeEach(() => setActivePinia(createPinia()));
const entry = (n, type = 'notification') => ({ direction: 'in', type, method: `method-${n}`, payload: { params: { text: `payload-${n}` } } });

test('captured JSON snapshots stay raw instead of paying for deep reactivity', () => {
  const store = useTrafficStore(), frame = entry(1);
  store.addEntry(frame);
  assert.equal(isProxy(store.entries[0]), false);
  assert.equal(store.entries[0].payload, frame.payload);
  assert.equal(isProxy(store.entries[0].payload.params), false);
});

test('monitor observers update from the first frame and continue after reaching the limit', () => {
  const store = useTrafficStore();
  let latest;
  const stop = watchEffect(() => { latest = store.filteredEntries.at(-1)?.method; }, {flush:'sync'});
  try {
    store.addEntry(entry(0));
    assert.equal(latest, 'method-0');
    for (let i = 1; i <= 600; i++) store.addEntry(entry(i));
    assert.equal(store.entries.length, 500);
    assert.equal(store.entries[0].method, 'method-101');
    assert.equal(latest, 'method-600');
    assert.equal(new Set(store.entries.map(e => e.id)).size, 500);
    store.clear();
    assert.equal(latest, undefined);
    assert.equal(store.entries.length, 0);
  } finally { stop(); }
});

test('pause, request filters and payload search retain their behavior', () => {
  const store = useTrafficStore();
  store.addEntry(entry('a', 'request'));
  store.addEntry(entry('b', 'response'));
  store.addEntry(entry('c'));
  store.togglePause();store.addEntry(entry('ignored'));
  assert.equal(store.entries.length, 3);
  store.setFilter('responses');
  assert.equal(store.filteredEntries[0].method, 'method-b');
  store.setFilter('all');store.setSearch('PAYLOAD-C');
  assert.equal(store.filteredEntries.length, 1);
  assert.equal(store.filteredEntries[0].method, 'method-c');
  store.clearSearch();store.togglePause();store.addEntry(entry('d'));
  assert.equal(store.filteredEntries.length, 4);
});
