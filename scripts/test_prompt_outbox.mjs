import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptOutbox } from '../src/lib/promptOutbox.ts';
import { steeringDelivery } from '../src/lib/steeringDelivery.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  let busy = true, connected = true, finish;
  const calls = [], stored = new Map();
  const box = createPromptOutbox({
    busy: () => busy, connected: () => connected,
    send: async (text, files) => { calls.push(['send', text, files]); busy = true; await new Promise(r => finish = r); busy = false; },
    steer: async (text, files) => { calls.push(['steer', text, files]); return 'injected'; },
    storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) },
  });
  box.restore('agent::one');
  return { box, calls, stored, idle: () => { busy = false; box.ready(); }, finish: () => finish(), disconnect: () => { connected = false; box.pause(); } };
}

test('Queue waits for full completion, preserves FIFO and attachments', async () => {
  const f = fixture(), file = { id: 'f', name: 'notes.txt', kind: 'text', body: 'notes' };
  f.box.submit('first', [file]); f.box.submit('second');
  f.box.toolBoundary(); await tick(); assert.equal(f.calls.length, 0);
  f.idle(); await tick(); assert.deepEqual(f.calls, [['send', 'first', [file]]]);
  assert.equal(f.box.messages.value[0].text, 'second');
  f.finish(); await tick(); assert.equal(f.calls[1][1], 'second');
  f.finish(); await tick(); assert.equal(f.box.messages.value.length, 0);
});

test('Steer waits for a tool boundary and bypasses the end-of-turn queue without cancel', async () => {
  const f = fixture();
  f.box.submit('later'); f.box.submit('correction', [], 'steer');
  await tick(); assert.deepEqual(f.calls, []);
  f.box.toolBoundary(); await tick(); assert.deepEqual(f.calls, [['steer', 'correction', []]]);
  assert.equal(f.box.messages.value[0].text, 'later');
  f.idle(); await tick(); assert.equal(f.calls[1][1], 'later'); f.finish();
});

test('Steer becomes an ordinary next turn if the current turn ends first', async () => {
  const f = fixture(); f.box.submit('correction', [], 'steer');
  f.idle(); await tick(); assert.equal(f.calls[0][0], 'send'); f.finish();
});

test('Stop/disconnect pauses pending work; removal and explicit resume are safe', async () => {
  const f = fixture(); const id = f.box.submit('remove'); f.box.submit('keep');
  f.box.remove(id); f.box.pause(); f.idle(); await tick(); assert.deepEqual(f.calls, []);
  f.box.resume(); await tick(); assert.equal(f.calls[0][1], 'keep');
  f.disconnect(); f.box.submit('offline'); f.finish(); await tick(); assert.equal(f.calls.length, 1);
});

test('sessions are isolated and reload restores a paused queue, without automatic resends', async () => {
  const a = fixture(), b = fixture(); a.box.submit('A'); b.box.submit('B');
  b.idle(); await tick(); assert.deepEqual(a.calls, []); assert.equal(b.calls[0][1], 'B'); b.finish();
  const calls = [];
  const restored = createPromptOutbox({ busy: () => false, connected: () => true,
    send: async text => calls.push(text), steer: async () => 'injected',
    storage: { getItem: k => a.stored.get(k) ?? null, setItem: (k, v) => a.stored.set(k, v), removeItem: k => a.stored.delete(k) },
  });
  restored.restore('agent::one'); restored.ready(); await tick();
  assert.equal(restored.messages.value[0].text, 'A'); assert.equal(restored.paused.value, true); assert.deepEqual(calls, []);
  restored.resume(); await tick(); assert.deepEqual(calls, ['A']);
});

test('a delivery failure is visible and does not automatically retry or send the next item', async () => {
  let fail = true;
  const box = createPromptOutbox({ busy: () => false, connected: () => true,
    send: async () => { if (fail) throw new Error('Offline'); }, steer: async () => 'injected', storage: null });
  box.submit('failed'); box.submit('next'); await tick();
  assert.equal(box.paused.value, true); assert.match(box.messages.value[0].error, /Offline/);
  fail = false; box.ready(); await tick(); assert.equal(box.messages.value.length, 2);
});

test('ambiguous native new-turn fallback holds queued sends until explicit resume', async () => {
  let busy = true;
  const calls = [];
  const box = createPromptOutbox({ busy: () => busy, connected: () => true,
    send: async t => calls.push(t), steer: async () => 'startedNewTurn', storage: null });
  box.submit('later'); box.submit('steer', [], 'steer'); box.toolBoundary(); await tick();
  busy = false; box.ready(); await tick(); assert.equal(box.paused.value, true); assert.deepEqual(calls, []);
  assert.match(box.notice.value, /new turn/i);
  box.resume(); await tick(); assert.deepEqual(calls, ['later']);
});

test('verified Porch-style delivery profiles do not depend on display names', () => {
  assert.equal(steeringDelivery({ _meta: { steering: { supported: true } } }), 'extension');
  assert.equal(steeringDelivery({ agentInfo: { name: 'OpenCode' } }), 'concurrent-prompt');
  assert.equal(steeringDelivery({ agentInfo: { name: 'affogato', title: 'Devin Agent' } }), 'concurrent-prompt');
  assert.equal(steeringDelivery({ agentInfo: { name: 'hermes-agent' } }), 'hermes-command');
  assert.equal(steeringDelivery({ agentInfo: { name: 'Custom Devin' } }), null);
  assert.equal(steeringDelivery({ agentInfo: { name: 'affogato', title: 'Unknown' } }), null);
});

test('a storage quota failure keeps unsent work intact; idle sends do not require storing large attachments', async () => {
  let busy = true;
  const calls = [];
  const box = createPromptOutbox({ busy: () => busy, connected: () => true,
    send: async (text, files) => calls.push([text, files]), steer: async () => 'injected',
    storage: { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); }, removeItem: () => {} },
  });
  box.restore('agent::quota');
  assert.throws(() => box.submit('queued'), /Quota exceeded/);
  assert.deepEqual(box.messages.value, []); assert.deepEqual(calls, []);
  busy = false; const files = [{ id: 'large', kind: 'image', name: 'large.png', data: 'bytes' }];
  box.submit('immediate', files); await tick(); assert.deepEqual(calls, [['immediate', files]]);
});

test('malformed restored attachments pause safely instead of crashing the composer', () => {
  const saved = [{ id: 'bad', text: 'broken', mode: 'queue', attachments: [null] }];
  const box = createPromptOutbox({ busy: () => false, connected: () => true,
    send: async () => { throw new Error('must not send'); }, steer: async () => 'injected',
    storage: { getItem: () => JSON.stringify(saved), setItem: () => {}, removeItem: () => {} },
  });
  box.restore('agent::bad');
  assert.deepEqual(box.messages.value, []); assert.equal(box.paused.value, true);
  assert.match(box.notice.value, /Could not restore queue/);
});

test('a new Steer submitted during a prior ACK waits for a fresh tool boundary', async () => {
  const calls = []; let ack;
  const box = createPromptOutbox({ busy: () => true, connected: () => true, storage: null,
    send: async () => {}, steer: async text => { calls.push(text); if (calls.length === 1) await new Promise(r => ack = r); return 'injected'; } });
  box.submit('first', [], 'steer'); box.toolBoundary(); await tick();
  box.submit('second', [], 'steer'); ack(); await tick();
  assert.deepEqual(calls, ['first']);
  box.toolBoundary(); await tick(); assert.deepEqual(calls, ['first', 'second']);
});

test('a concurrent prompt failure after acceptance retains its failed message', async () => {
  let rejectLater;
  const box = createPromptOutbox({ busy: () => true, connected: () => true, storage: null,
    send: async () => {}, steer: async (_text, _files, failed) => { rejectLater = failed; return 'injected'; } });
  box.submit('correction', [], 'steer'); box.toolBoundary(); await tick();
  assert.equal(typeof rejectLater, 'function');
  rejectLater(new Error('Late transport failure')); await tick();
  assert.equal(box.messages.value[0].text, 'correction');
  assert.match(box.messages.value[0].error, /Late transport failure/);
  assert.equal(box.paused.value, true);
});

test('a failed delivery is removed only when authoritative history confirms its exact user-turn position', async () => {
  const box = createPromptOutbox({ busy: () => false, connected: () => true, storage: null,
    deliveryAnchor: () => ({ userTurn: 3, text: 'repeat' }),
    send: async () => { throw new Error('transport closed'); }, steer: async () => 'injected' });
  box.submit('repeat'); await tick();
  box.reconcile([{role:'user',content:'repeat'},{role:'assistant',content:'old reply'},{role:'user',content:'different'}]);
  assert.equal(box.messages.value.length,1,'an older identical message is not delivery proof');
  box.reconcile([{role:'user',content:'old'},{role:'user',content:'different'},{role:'user',content:'repeat'}]);
  assert.equal(box.messages.value.length,0,'confirmed delivery is no longer pending');
});

test('an old failed queue entry can be reconciled against its cached ordinal without matching arbitrary history text', async () => {
  const saved=[{id:'old',text:'Ну как',mode:'queue',attachments:[],error:'transport closed'}];
  const box=createPromptOutbox({busy:()=>false,connected:()=>true,storage:{getItem:()=>JSON.stringify(saved),setItem(){},removeItem(){}},send:async()=>assert.fail('must not resend'),steer:async()=> 'injected'});
  box.restore('agent::old');
  const cached={userTurnBase:2,messages:[{role:'user',content:'Ну как'},{role:'assistant',content:'answer'}]};
  box.reconcile([{role:'user',content:'a'},{role:'user',content:'b'},{role:'user',content:'Ну как'},{role:'assistant',content:'answer'}],cached);
  assert.equal(box.messages.value.length,0);assert.equal(box.notice.value,'');
});

test('accepted delivery reconciles against an absolute ordinal in a resumed tail', () => {
 const data=new Map([['acp-ui:outbox:review-tail',JSON.stringify([{id:'sent',text:'delivered',mode:'queue',attachments:[],error:'connection lost',delivery:{userTurn:8,text:'delivered'}}])]]);
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const box=createPromptOutbox({busy:()=>true,connected:()=>false,send:async()=>{},steer:async()=>{},storage});
 box.restore('review-tail');
 assert.equal(box.messages.value.length,1);
 assert.equal(box.reconcile([{role:'user',content:'previous'},{role:'assistant',content:'answer'},{role:'user',content:'delivered'}],null,6),1);
 assert.equal(box.messages.value.length,0,'the acknowledged turn must never be offered for re-send');
});
