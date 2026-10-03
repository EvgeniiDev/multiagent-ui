// scripts/test_swarm_protocol.mjs — S1 protocol tests.
//   node --test scripts/test_swarm_protocol.mjs
//
// Covers: competing claims -> single owner; silence != consent; transfer
// rejected during active turn; global decisions need everyone; user decision
// keeps document gate; foreign/stale tokens rejected; past-turn commands
// (incl. reviewer-fix) rejected after a new turn; text change between acks
// and late ack of an old revision never yield agreement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSwarmProtocol, createInitialState, sha256Hex,
} from '../server/execution/swarm/protocol.mjs';

function setup({ now = (() => 1000) } = {}) {
  const p = createSwarmProtocol({ runId: 'run1', now });
  p.dispatch({ type: 'register_participant', participantId: 'a', callsign: 'alpha' });
  p.dispatch({ type: 'register_participant', participantId: 'b', callsign: 'beta' });
  return p;
}

function turn(p, pid, attempt = 'at1', turnId = 't1') {
  return p.dispatch({ type: 'start_turn', participantId: pid, attemptId: attempt, turnId }).lease;
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected error ${code}, call succeeded`);
}

test('competing claims: one owner, second claim rejected', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  const lb = turn(p, 'b');
  const err = expectCode(() => p.dispatch({ type: 'claim_file', auth: lb, path: 'src/a.js' }), 'already_owned');
  assert.equal(err.extra.owner, 'a');
  p.dispatch({ type: 'end_turn', auth: la });
  p.dispatch({ type: 'end_turn', auth: lb });
});

test('silence is not consent: single ack never agrees a two-party decision', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  p.dispatch({ type: 'declare_consumer', auth: la, path: 'src/a.js', participantId: 'b' });
  const d = p.dispatch({ type: 'open_decision', auth: la, text: 'use x', scope: { kind: 'file', path: 'src/a.js' } });
  assert.deepEqual(d.affected, ['a', 'b']);
  const r = p.dispatch({ type: 'ack_decision', auth: la, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  assert.equal(r.agreed, false);
  assert.deepEqual(r.missing, ['b']);
  assert.equal(p.getState().decisions[d.decisionId].status, 'pending');
});

test('file decision reaches agreement after all affected ack', () => {
  const p = setup();
  const la = turn(p, 'a');
  const lb = turn(p, 'b');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  p.dispatch({ type: 'declare_consumer', auth: la, path: 'src/a.js', participantId: 'b' });
  const d = p.dispatch({ type: 'open_decision', auth: la, text: 'use x', scope: { kind: 'file', path: 'src/a.js' } });
  p.dispatch({ type: 'ack_decision', auth: la, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  const r = p.dispatch({ type: 'ack_decision', auth: lb, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  assert.equal(r.agreed, true);
  assert.equal(p.getState().decisions[d.decisionId].status, 'agreed');
});

test('transfer rejected while either side holds an active turn', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  expectCode(
    () => p.dispatch({ type: 'request_transfer', auth: { participantId: 'a' }, path: 'src/a.js', to: 'b' }),
    'transfer_during_active_turn');
  p.dispatch({ type: 'end_turn', auth: la });
  // both turn-free now: request (owner pre-consents) + recipient consent completes
  p.dispatch({ type: 'request_transfer', auth: { participantId: 'a' }, path: 'src/a.js', to: 'b' });
  p.dispatch({ type: 'consent_transfer', auth: { participantId: 'b' }, path: 'src/a.js' });
  assert.equal(p.getState().files['src/a.js'].owner, 'b');
});

test('global decision requires every participant', () => {
  const p = setup();
  const la = turn(p, 'a');
  const d = p.dispatch({ type: 'open_decision', auth: la, text: 'api v2', scope: { kind: 'global' } });
  assert.deepEqual(d.affected, ['a', 'b']);
  p.dispatch({ type: 'ack_decision', auth: la, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  assert.equal(p.getState().decisions[d.decisionId].status, 'pending');
});

test('user directive: non-document scope agrees immediately, document scope stays gated', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  const open = p.dispatch({
    type: 'user_directive', auth: { role: 'user' }, text: 'stop and report',
    scope: { kind: 'file', path: 'src/a.js' }, options: ['x', 'y'], consequences: 'z',
  });
  assert.equal(open.gated, false);
  const gated = p.dispatch({
    type: 'user_directive', auth: { role: 'user' }, text: 'change requirements',
    scope: { kind: 'file', path: 'src/a.js', touchesDocuments: true },
  });
  assert.equal(gated.gated, true);
  assert.equal(p.getState().decisions[gated.decisionId].status, 'pending');
  expectCode(() => p.dispatch({
    type: 'user_directive', auth: { role: 'peer' }, text: 'x', scope: { kind: 'global' },
  }), 'forbidden_role');
});

test('foreign token and past-turn command rejected; reviewer-fix after new turn rejected', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  const lb = turn(p, 'b', 'at2', 'tb1');
  // b presents a's lease fields (attempt/turn/generation of a) -> stale_lease
  expectCode(() => p.dispatch({
    type: 'send_message', auth: { ...la, participantId: 'b' }, to: 'all', body: 'hi',
  }), 'stale_lease');
  // unknown participant
  expectCode(() => p.dispatch({
    type: 'send_message',
    auth: { participantId: 'ghost', attemptId: 'x', turnId: 'y', generation: 1 }, to: 'all', body: 'hi',
  }), 'unknown_participant');
  // a ends turn 1, starts turn 2: the old lease (gen 1) is dead
  p.dispatch({ type: 'end_turn', auth: la });
  const la2 = p.dispatch({ type: 'start_turn', participantId: 'a', attemptId: 'at1', turnId: 't2' }).lease;
  assert.equal(la2.generation, 2);
  expectCode(() => p.dispatch({ type: 'send_message', auth: la, to: 'all', body: 'reviewer fix' }), 'stale_lease');
  expectCode(() => p.dispatch({
    type: 'ack_decision', auth: la, decisionId: 'nope', rev: 1, revHash: 'x',
  }), 'stale_lease');
  void lb;
});

test('text change between acks resets readiness; late ack of old revision rejected', () => {
  const p = setup();
  const la = turn(p, 'a');
  const lb = turn(p, 'b');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  p.dispatch({ type: 'declare_consumer', auth: la, path: 'src/a.js', participantId: 'b' });
  const d = p.dispatch({ type: 'open_decision', auth: la, text: 'v1', scope: { kind: 'file', path: 'src/a.js' } });
  p.dispatch({ type: 'ack_decision', auth: la, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  const d2 = p.dispatch({ type: 'amend_decision', auth: lb, decisionId: d.decisionId, text: 'v2' });
  assert.notEqual(d2.revHash, d.revHash);
  const st = p.getState().decisions[d.decisionId];
  assert.equal(st.status, 'pending');
  // late ack of rev 1 is recorded as stale history, never counts
  const err = expectCode(() => p.dispatch({
    type: 'ack_decision', auth: lb, decisionId: d.decisionId, rev: 1, revHash: d.revHash,
  }), 'stale_revision');
  assert.equal(err.extra.latestRev, 2);
  assert.equal(st.ackHistory.filter((h) => h.outcome === 'stale').length, 1);
  assert.equal(st.status, 'pending');
  // fresh acks on rev 2 agree
  p.dispatch({ type: 'ack_decision', auth: la, decisionId: d.decisionId, rev: 2, revHash: d2.revHash });
  const r = p.dispatch({ type: 'ack_decision', auth: lb, decisionId: d.decisionId, rev: 2, revHash: d2.revHash });
  assert.equal(r.agreed, true);
});

test('expanding the circle cancels prior readiness', () => {
  const p = setup();
  p.dispatch({ type: 'register_participant', participantId: 'c', callsign: 'gamma' });
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  p.dispatch({ type: 'declare_consumer', auth: la, path: 'src/a.js', participantId: 'b' });
  const d = p.dispatch({ type: 'open_decision', auth: la, text: 'v1', scope: { kind: 'file', path: 'src/a.js' } });
  const lb = turn(p, 'b');
  p.dispatch({ type: 'ack_decision', auth: la, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  p.dispatch({ type: 'ack_decision', auth: lb, decisionId: d.decisionId, rev: 1, revHash: d.revHash });
  assert.equal(p.getState().decisions[d.decisionId].status, 'agreed');
  // c becomes a consumer of the file: agreement is cancelled
  p.dispatch({ type: 'declare_consumer', auth: la, path: 'src/a.js', participantId: 'c' });
  const st = p.getState().decisions[d.decisionId];
  assert.equal(st.status, 'pending');
  assert.ok(st.affected.includes('c'));
});

test('force transfer needs confirmed-terminal owner with no active turn', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  expectCode(() => p.dispatch({
    type: 'transfer_force', auth: { role: 'user' }, path: 'src/a.js', to: 'b', ownerTerminal: true,
  }), 'owner_active');
  p.dispatch({ type: 'end_turn', auth: la });
  expectCode(() => p.dispatch({
    type: 'transfer_force', auth: { role: 'user' }, path: 'src/a.js', to: 'b',
  }), 'terminal_unconfirmed');
  p.dispatch({
    type: 'transfer_force', auth: { role: 'user' }, path: 'src/a.js', to: 'b', ownerTerminal: true,
  });
  assert.equal(p.getState().files['src/a.js'].owner, 'b');
});

test('revision hashes bind text, sorted affected identities and exact ownership scope', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  const d = p.dispatch({ type: 'open_decision', auth: la, text: 'hello', scope: { kind: 'file', path: 'src/a.js' } });
  const { canonicalJson } = { canonicalJson: (v) => JSON.stringify(v) };
  void canonicalJson;
  const expected = sha256Hex(`{"affected":["a"],"scopeBinding":{"kind":"file","paths":[{"consumers":[],"owner":"a","path":"src/a.js","version":1}]},"text":"hello"}`);
  assert.equal(d.revHash, expected);
});

test('state survives toJSON/loadJSON round-trip', () => {
  const p = setup();
  const la = turn(p, 'a');
  p.dispatch({ type: 'claim_file', auth: la, path: 'src/a.js' });
  const snap = p.toJSON();
  const q = createSwarmProtocol({ runId: 'run1', now: () => 2000, initialState: createInitialState({ runId: 'run1', now: () => 1 }) });
  q.loadJSON(snap);
  assert.equal(q.getState().files['src/a.js'].owner, 'a');
  expectCode(() => q.loadJSON(JSON.stringify({ version: 999, runId: 'run1' })), undefined);
});

test('circle changes require a new exact revision and fresh acknowledgments from everybody',()=>{
 const p=setup(),a=turn(p,'a');p.dispatch({type:'claim_file',auth:a,path:'src/a.js'});
 const d=p.dispatch({type:'open_decision',auth:a,text:'contract',scope:{kind:'file',path:'src/a.js'}});
 p.dispatch({type:'ack_decision',auth:a,decisionId:d.decisionId,rev:1,revHash:d.revHash});
 p.dispatch({type:'declare_consumer',auth:a,path:'src/a.js',participantId:'b'});
 const b=turn(p,'b'),row=p.getState().decisions[d.decisionId],latest=row.revisions.at(-1);
 assert.equal(latest.rev,2);assert.notEqual(latest.revHash,d.revHash);assert.deepEqual(row.acks[2],{});
 expectCode(()=>p.dispatch({type:'ack_decision',auth:b,decisionId:d.decisionId,rev:1,revHash:d.revHash}),'stale_revision');
 assert.equal(p.dispatch({type:'ack_decision',auth:b,decisionId:d.decisionId,rev:2,revHash:latest.revHash}).agreed,false);
 assert.equal(p.dispatch({type:'ack_decision',auth:a,decisionId:d.decisionId,rev:2,revHash:latest.revHash}).agreed,true);
});
test('owner transfer and global registration invalidate exact decision bindings',()=>{
 const p=setup(),a=turn(p,'a');p.dispatch({type:'claim_file',auth:a,path:'src/a.js'});
 const d=p.dispatch({type:'open_decision',auth:a,text:'contract',scope:{kind:'file',path:'src/a.js'}});
 p.dispatch({type:'ack_decision',auth:a,decisionId:d.decisionId,rev:1,revHash:d.revHash});p.dispatch({type:'end_turn',auth:a});
 p.dispatch({type:'transfer_force',auth:{role:'user'},path:'src/a.js',to:'b',ownerTerminal:true});
 const latest=p.getState().decisions[d.decisionId].revisions.at(-1);assert.equal(latest.rev,2);assert.deepEqual(latest.affected,['b']);assert.notEqual(latest.revHash,d.revHash);
 const b=turn(p,'b');const global=p.dispatch({type:'open_decision',auth:b,text:'all',scope:{kind:'global'}});
 p.dispatch({type:'register_participant',participantId:'c',callsign:'gamma'});
 const g=p.getState().decisions[global.decisionId];assert.equal(g.revisions.at(-1).rev,2);assert.deepEqual(g.acks[2],{});assert.ok(g.affected.includes('c'));
});
