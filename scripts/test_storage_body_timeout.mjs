// A response can send headers immediately and never finish its JSON body.
// Session startup must still leave the shared-state queue on its deadline.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./test_sfc_loader.mjs', import.meta.url));
const { loadKvStore, mutateRemoteDoc, mutateRemoteDocChecked, __resetWebKvForTests } = await import('../src/lib/host/storage.ts');
let originals, local, stalled, cancelBodies, polls;
const json = body => new Response(JSON.stringify(body), { status: 200 });
const doc = { rev: 1, updatedAt: 1, data: { lastCwd: '/cached' } };
function stalledBody(init) {
  stalled++;
  return { ok: true, status: 200, json: () => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    cancelBodies.push(abort);
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort, { once: true });
  }) };
}
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('JSON body outlived the request deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
beforeEach(() => {
  originals = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, setInterval: globalThis.setInterval };
  local = new Map([['acp-ui:preferences.json', JSON.stringify(doc.data)]]);
  globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
  polls = [];
  globalThis.setInterval = (fn, ms) => { polls.push(fn); return originals.setInterval(fn, ms); };
  stalled = 0;
  cancelBodies = [];
});
afterEach(async () => {
  for (const cancel of cancelBodies) cancel();
  await __resetWebKvForTests();
  Object.assign(globalThis, originals);
});
test('health response body cannot leave startup waiting forever', async () => {
  globalThis.fetch = async (url, init) => stalledBody(init);
  const store = await bounded(loadKvStore('preferences.json'), 2300);
  assert.equal(await store.get('lastCwd'), '/cached');
  assert.equal(stalled, 1);
});
test('document response body times out and preserves the local session preferences', async () => {
  globalThis.fetch = async (url, init) => String(url).endsWith('/health') ? json({ ok: true }) : stalledBody(init);
  const store = await bounded(loadKvStore('preferences.json'), 4800);
  assert.equal(await store.get('lastCwd'), '/cached');
  assert.equal(stalled, 1);
});
test('save response body times out, unblocks later saves and keeps the local mirror', async () => {
  globalThis.fetch = async (url, init) => String(url).endsWith('/health') ? json({ ok: true })
    : init.method === 'PUT' ? (stalled ? json({ rev: 2, updatedAt: 2 }) : stalledBody(init)) : json(doc);
  const store = await loadKvStore('preferences.json');
  await store.set('lastCwd', '/new');
  await bounded(store.save(), 4800);
  assert.equal(JSON.parse(local.get('acp-ui:preferences.json')).lastCwd, '/new');
  // A changed snapshot must still be sent after an ambiguous timeout.
  // Repeated saves of that same snapshot share the failed attempt.
  await bounded(store.save(), 500);
  assert.equal(stalled, 1, 'an unchanged failed snapshot must not repeat its timeout');
  await store.set('lastCwd', '/next');
  await bounded(store.save(), 4800);
  assert.equal(stalled, 1, 'recovered backend must accept the newer snapshot');
  assert.equal(JSON.parse(local.get('acp-ui:preferences.json')).lastCwd, '/next');
});

test('legacy mutations return failure when a successful-status body stalls', async () => {
  globalThis.fetch = async (url, init) => String(url).endsWith('/health') ? json({ ok: true })
    : init.method === 'PUT' ? stalledBody(init) : json(doc);
  assert.equal(await bounded(mutateRemoteDoc('preferences.json', data => ({ ...data, lastCwd: '/new' })), 4800), false);
});
test('checked mutations do not report success after the response body was aborted', async () => {
  globalThis.fetch = async (url, init) => String(url).endsWith('/health') ? json({ ok: true })
    : init.method === 'PUT' ? stalledBody(init) : json(doc);
  const result = await bounded(mutateRemoteDocChecked('preferences.json', data => ({ ...data, lastCwd: '/new' })), 4800);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
});

test('an ambiguous committed PUT cannot discard a newer queued session snapshot', async () => {
  let remote = structuredClone(doc), attempts = [], failFirst = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return json({ ok: true });
    if (init.method !== 'PUT') return json(remote);
    const payload = JSON.parse(init.body);
    attempts.push(payload);
    if (payload.rev !== remote.rev) return new Response('{}', { status: 409 });
    remote = { rev: remote.rev + 1, updatedAt: Date.now() + 1000, data: payload.data };
    if (failFirst) { failFirst = false; return stalledBody(init); }
    return json({ rev: remote.rev, updatedAt: remote.updatedAt });
  };
  const store = await loadKvStore('sessions.json');
  await store.set('sessions', ['first']);
  const first = store.save();
  // Let the first snapshot reach the server before editing the second one.
  while (!stalled) await new Promise(resolve => setTimeout(resolve, 1));
  await store.set('sessions', ['first', 'new']);
  const second = store.save();
  await bounded(Promise.all([first, second]), 4800);
  assert.deepEqual(remote.data.sessions, ['first', 'new']);
  assert.ok(attempts.every(attempt => typeof attempt.rev === 'number'), 'retry must retain CAS');
  await __resetWebKvForTests();
  const reopened = await loadKvStore('sessions.json');
  assert.deepEqual(await reopened.get('sessions'), ['first', 'new']);
});

test('identical saves queued before failure share one request timeout', async () => {
  globalThis.fetch = async (url, init) => String(url).endsWith('/health') ? json({ ok: true })
    : init.method === 'PUT' ? stalledBody(init) : json(doc);
  const store = await loadKvStore('preferences.json');
  await store.set('lastCwd', '/latest');
  await bounded(Promise.all([store.save(), store.save(), store.save()]), 4800);
  assert.equal(stalled, 1);
});

test('failed reconciliation cannot forget which timed-out snapshot committed', async () => {
  let remote = structuredClone(doc), failRead = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return json({ ok: true });
    if (init.method !== 'PUT') {
      if (failRead) throw new Error('temporary GET failure');
      return json(remote);
    }
    const payload = JSON.parse(init.body);
    if (payload.rev !== remote.rev) return new Response('{}', { status: 409 });
    remote = { rev: remote.rev + 1, updatedAt: Date.now() + 1000, data: payload.data };
    if (!stalled) return stalledBody(init);
    return json({ rev: remote.rev, updatedAt: remote.updatedAt });
  };
  const store = await loadKvStore('sessions.json');
  await store.set('sessions', ['first']);
  const first = store.save();
  while (!stalled) await new Promise(resolve => setTimeout(resolve, 1));
  await store.set('sessions', ['first', 'new']);
  failRead = true;
  await bounded(Promise.all([first, store.save()]), 4800);
  failRead = false;
  polls.at(-1)();
  await bounded((async () => {
    while (remote.data.sessions.length !== 2) await new Promise(resolve => setTimeout(resolve, 1));
  })(), 500);
  assert.deepEqual(remote.data.sessions, ['first', 'new']);
});

test('same-millisecond edits remain dirty until their exact snapshot is acknowledged', async () => {
  let remote = structuredClone(doc), release, puts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return json({ ok: true });
    if (init.method !== 'PUT') return json(remote);
    const payload = JSON.parse(init.body);
    puts++;
    remote = { rev: remote.rev + 1, updatedAt: 200, data: payload.data };
    if (puts === 1) await new Promise(resolve => { release = resolve; });
    return json({ rev: remote.rev, updatedAt: remote.updatedAt });
  };
  const store = await loadKvStore('sessions.json');
  const realNow = Date.now;
  try {
    Date.now = () => 100;
    await store.set('sessions', ['first']);
    const saved = store.save();
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    await store.set('sessions', ['first', 'new']);
    release();
    await saved;
    polls.at(-1)();
    await bounded((async () => {
      while (remote.data.sessions.length !== 2) await new Promise(resolve => setTimeout(resolve, 1));
    })(), 500);
    assert.deepEqual(remote.data.sessions, ['first', 'new']);
  } finally { Date.now = realNow; release?.(); }
});

test('checked mutations retain protected-field rejection codes and never force-write', async () => {
  const puts = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return json({ ok: true });
    if (init.method !== 'PUT') return json(doc);
    puts.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ code: 'managed_claim_protected', error: 'protected' }), { status: 409 });
  };
  const result = await mutateRemoteDocChecked('board.json', data => ({ ...data, edited: true }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rejected');
  assert.equal(result.code, 'managed_claim_protected');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].rev, doc.rev);
});

test('a later transport failure cannot erase an earlier possibly committed snapshot', async () => {
  let remote = structuredClone(doc), failPut = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) return json({ ok: true });
    if (init.method !== 'PUT') return json(remote);
    if (failPut) throw new Error('PUT did not reach the server');
    const payload = JSON.parse(init.body);
    if (payload.rev !== remote.rev) return new Response('{}', { status: 409 });
    remote = { rev: remote.rev + 1, updatedAt: Date.now() + 1000, data: payload.data };
    if (!stalled) return stalledBody(init);
    return json({ rev: remote.rev, updatedAt: remote.updatedAt });
  };
  const store = await loadKvStore('sessions.json');
  await store.set('sessions', ['first']);
  const first = store.save();
  while (!stalled) await new Promise(resolve => setTimeout(resolve, 1));
  await store.set('sessions', ['first', 'new']);
  failPut = true;
  await bounded(Promise.all([first, store.save()]), 4800);
  failPut = false;
  polls.at(-1)();
  await bounded((async () => {
    while (remote.data.sessions.length !== 2) await new Promise(resolve => setTimeout(resolve, 1));
  })(), 500);
  assert.deepEqual(remote.data.sessions, ['first', 'new']);
});

test('oversized server ledger stays available without repeatedly exhausting browser storage', async () => {
  const data = { entries: [{ detail: 'x'.repeat(3*1024*1024) }] };
  let attempts = 0;
  local.set('acp-ui:activity.json', 'obsolete mirror');
  globalThis.localStorage.removeItem = key => local.delete(key);
  globalThis.localStorage.setItem = (key, value) => {
    if (key === 'acp-ui:activity.json') attempts++;
    if (value.length > 256*1024) throw new DOMException('full', 'QuotaExceededError');
    local.set(key,value);
  };
  globalThis.fetch = async url => String(url).endsWith('/health') ? json({ok:true}) : json({rev:1,updatedAt:1,data});
  const store = await loadKvStore('activity.json');
  assert.deepEqual(await store.get('entries'), data.entries, 'the full authoritative ledger remains in memory');
  assert.equal(attempts,0,'oversized optional mirrors must not attempt quota-sized writes');
  assert.equal(local.has('acp-ui:activity.json'),false,'remove the obsolete oversized mirror');
});

test('failed server saves preserve larger pending offline mirrors', async () => {
  const entries=[{detail:'x'.repeat(300*1024)}];
  globalThis.fetch=async (url,init={}) => {
    if(String(url).endsWith('/health'))return json({ok:true});
    if(init.method==='PUT')throw new Error('offline');
    return json({rev:1,updatedAt:1,data:{entries:[]}});
  };
  const store=await loadKvStore('activity.json');
  await store.set('entries',entries); await store.save();
  assert.deepEqual(JSON.parse(local.get('acp-ui:activity.json')).entries,entries);
  await __resetWebKvForTests();
  globalThis.fetch=async()=>{throw new Error('offline')};
  const reopened=await loadKvStore('activity.json');
  assert.deepEqual(await reopened.get('entries'),entries);
});

test('quota warnings stay bounded when acknowledged oversized ledgers are adopted again', async () => {
  let rev=1,warnings=0;
  const detail='x'.repeat(2*1024*1024), originalWarn=console.warn;
  globalThis.localStorage.removeItem = key => local.delete(key);
  globalThis.localStorage.setItem = () => { throw new DOMException('full','QuotaExceededError'); };
  globalThis.fetch=async (url,init={}) => {
    if(String(url).endsWith('/health'))return json({ok:true});
    if(init.method==='PUT')return json({rev:++rev,updatedAt:rev});
    return json({rev,updatedAt:rev,data:{detail}});
  };
  console.warn=()=>warnings++;
  try {
    const store=await loadKvStore('activity.json');
    await store.set('detail',detail);await store.save();
    rev++;await store.refresh();
    await store.set('detail',detail+'new');await store.save();
    assert.equal(warnings,1,'remote cache eviction must not rearm the same quota warning');
  } finally { console.warn=originalWarn; }
});
