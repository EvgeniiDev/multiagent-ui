// Regression tests for the ui store init race: a view picked while
// initUiStore is still awaiting the remote kv store must win — the
// late-arriving persisted value must not revert it (the click that landed
// during boot is real user intent).
//
//   node --experimental-strip-types scripts/test_ui_store.mjs
//   (the loader hooks resolve the repo's bundler-style imports;
//    globalThis.fetch is stubbed so loadKvStore takes the remote path
//    with a controllable delay)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./test_sfc_loader.mjs', import.meta.url));

const { createPinia, setActivePinia } = await import('pinia');
const { useUiStore } = await import('../src/stores/ui.ts');
const { __resetWebKvForTests } = await import('../src/lib/host/storage.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch stub: /health ok, preferences.json served with `delayMs`, PUTs recorded.
function stubRemote({ savedView, delayMs = 0, puts = [] }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes('/api/state/preferences.json')) {
      if ((init.method || 'GET') === 'GET') {
        if (delayMs) await sleep(delayMs);
        const doc =
          savedView === undefined
            ? null
            : { rev: 1, updatedAt: 1, data: { activeView: savedView } };
        if (!doc) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(doc), { status: 200 });
      }
      if (init.method === 'PUT') {
        puts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ rev: 2, updatedAt: 2 }), { status: 200 });
      }
    }
    return new Response('unexpected', { status: 500 });
  };
  return () => {
    globalThis.fetch = real;
  };
}

describe('ui store init race', () => {
  let restoreFetch;
  beforeEach(async () => {
    setActivePinia(createPinia());
    await __resetWebKvForTests();
  });
  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    await __resetWebKvForTests();
  });

  test('a view picked during init is not reverted by the saved value', async () => {
    const puts = [];
    restoreFetch = stubRemote({ savedView: 'chat', delayMs: 50, puts });
    const ui = useUiStore();
    const init = ui.initUiStore();          // pends on the delayed remote doc
    await ui.setView('board');              // the rail click that lands mid-boot
    await init;
    assert.equal(ui.activeView, 'board');
    // the picked view is persisted once the store lands
    assert.ok(puts.some((p) => p.data?.activeView === 'board'),
      'picked view must be persisted after init');
  });

  test('with no pick during init the saved view applies', async () => {
    restoreFetch = stubRemote({ savedView: 'board' });
    const ui = useUiStore();
    await ui.initUiStore();
    assert.equal(ui.activeView, 'board');
  });

  test('with no saved doc the default view stands', async () => {
    restoreFetch = stubRemote({ savedView: undefined });
    const ui = useUiStore();
    await ui.initUiStore();
    assert.equal(ui.activeView, 'chat');
  });
});
