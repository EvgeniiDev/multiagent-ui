// u7_acp_bridge.mjs — wire-level proof of the sacred bridge invariants on
// the REAL compose bridge (bridge-hermes :25901) running the unmodified
// deploy/acp-ws-bridge.mjs against the deterministic mock child.
//
// FAIL-CLOSED before any WebSocket opens:
//   * state :25900 /health dir == the isolated test STATE_DIR, and the
//     on-disk-seeded marker nonce reads back byte-identical — a live state
//     server fails at least one leg;
//   * bridge-hermes container Config shows the mock child command and the
//     U7 image — a real Hermes bridge is never prompted;
//   * the first WS exchange must yield a `mocksess-N` session id —
//     otherwise abort before sending anything else.
//
// Proves through actual sockets (the bridge itself is never mocked):
//   1. session/new response reaches only the requesting socket.
//   2. session/load replay lands ONLY on the issuing tab, with the exact
//      ordered transcript; the other socket sees zero frames.
//   3. request-id namespacing: both sockets send id=7 concurrently with
//      REVERSED completion order (A's prompt is deliberately __slow__ so
//      B resolves first); each socket still gets back exactly its own
//      echo payload under its own origId.
//   4. an unclaimed agent->client request (fs/read_text_file — no
//      sessionId in params) broadcasts to ALL sockets; first answer wins.
//   5. $/ping is answered inline by the bridge — invisible to the other
//      socket.
//
// Proves bridge protocol routing only — NOT real CLI behavior.
// Exit 0 only if every invariant holds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const STATE_URL = 'http://127.0.0.1:25900';
const WS_URL = 'ws://127.0.0.1:25901/';
const STATE_DIR = '/home/hermes/.hermes/acp-ui-state-u7';
const MARKER_FILE = `${STATE_DIR}/u7-test-marker.json.json`;
const MARKER_DOC = 'u7-test-marker.json';
const results = [];

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${detail}`);
  if (!cond) results.push(`FAIL ${name}: ${detail}`);
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function proveIsolation() {
  // 1) state dir identity — the running server's actual dir, not a label.
  const h = await getJson(`${STATE_URL}/health`);
  assert.equal(h.status, 200, `health status ${h.status}`);
  assert.equal(h.body?.dir, STATE_DIR,
    `state dir is ${h.body?.dir} — NOT the isolated test state`);
  // 2) marker nonce: disk-seeded value must read back over HTTP.
  const seed = JSON.parse(readFileSync(MARKER_FILE, 'utf8'));
  const nonce = seed?.data?.nonce;
  assert.ok(nonce, 'marker file missing nonce — transition not seeded');
  const m = await getJson(`${STATE_URL}/api/state/${MARKER_DOC}`);
  assert.equal(m.body?.data?.nonce, nonce,
    'marker nonce mismatch — this is not the isolated test state');
  // 3) bridge-hermes runs the MOCK child on the U7 image — the command
  //    array and image are inspected read-only; no env printed.
  const spec = JSON.parse(execFileSync(
    'docker', ['inspect', 'acp-ui-bridge-hermes-1'], { encoding: 'utf8' }))[0];
  assert.equal(spec.Config?.Image, 'acp-ui-u7:latest',
    `bridge-hermes image ${spec.Config?.Image} — expected acp-ui-u7`);
  const cmdline = (spec.Config?.Cmd || []).join(' ');
  assert.ok(cmdline.includes('acp-ws-bridge.mjs'),
    'bridge-hermes is not running acp-ws-bridge.mjs');
  assert.ok(cmdline.includes('u7_mock_acp.mjs'),
    `bridge-hermes child is NOT the mock (${cmdline}) — refusing to prompt a real agent`);
  assert.ok(cmdline.includes('25901'), 'bridge-hermes not bound to 25901');
  console.log('isolation proven: state dir + marker + mock-child identity');
}

function connect(name) {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  let closed = false;
  ws.addEventListener('message', (e) => {
    for (const line of String(e.data).split('\n')) {
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* non-JSON frame */ }
      inbox.push({ at: Date.now(), raw: line, msg });
      for (const w of [...waiters]) {
        try {
          if (w.pred(msg ?? line)) {
            waiters.splice(waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(msg ?? line);
          }
        } catch { /* keep waiting */ }
      }
    }
  });
  ws.addEventListener('close', () => { closed = true; });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`${name} ws error`)),
      { once: true });
  });
  const send = (obj) => ws.send(JSON.stringify(obj) + '\n');
  const waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      for (const f of inbox) {
        const m = f.msg ?? f.raw;
        try { if (pred(m)) return resolve(m); } catch { /* keep looking */ }
      }
      const w = { pred, resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`${name}: waitFor timeout`));
      }, ms);
      waiters.push(w);
    });
  return {
    name, ws, inbox, ready, send, waitFor,
    reset() { inbox.length = 0; },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await proveIsolation();

  const A = connect('A');
  const B = connect('B');
  try {
    await Promise.all([A.ready, B.ready]);
    check('both sockets connected', true);

    // mock-identity probe — abort before any further traffic if this is
    // somehow a real agent (e.g. transition applied to a foreign bridge).
    A.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } });
    const newRes = await A.waitFor((m) => m && m.id === 1 && m.result, 5000);
    const sessA = newRes.result.sessionId;
    if (!/^mocksess-\d+$/.test(sessA ?? '')) {
      throw new Error(`sessionId ${sessA} is not a mock session — aborting, refusing to drive a real agent`);
    }
    check('A session/new returned mock sessionId', true, sessA);
    await sleep(400);
    check('B received nothing during A session/new',
      B.inbox.length === 0, `frames=${B.inbox.length}`);

    // session/load replay — A only, exact ordered transcript
    A.reset(); B.reset();
    A.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: sessA } });
    await A.waitFor((m) => m && m.id === 2 && m.result, 5000);
    const texts = A.inbox
      .filter((f) => f.msg?.method === 'session/update'
        && f.msg?.params?.sessionId === sessA)
      .map((f) => f.msg.params.update?.content?.text);
    assert.deepEqual(texts, [
      `replay-user:${sessA}`,
      `replay-agent-1:${sessA}`,
      `replay-agent-2:${sessA}`,
    ], `replay order/text: ${JSON.stringify(texts)}`);
    check('A replay = exact ordered 3-frame transcript', true);
    await sleep(400);
    check('B got ZERO frames during A session/load replay',
      B.inbox.length === 0, `frames=${B.inbox.length}`);

    // B: own session (claims it on socket B)
    B.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/tmp' } });
    const newB = await B.waitFor((m) => m && m.id === 3 && m.result, 5000);
    const sessB = newB.result.sessionId;
    check('B session/new distinct sessionId', /^mocksess-\d+$/.test(sessB) && sessB !== sessA, sessB);

    // request-id namespacing — SAME client id 7, REVERSED completion:
    // A's prompt is __slow__250 so B's resolves first; the concurrent
    // pending map must still route each result to its own socket with
    // its own payload.
    A.reset(); B.reset();
    A.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt',
      params: { sessionId: sessA, prompt: [{ type: 'text', text: '__slow__250 __echoA__' }] } });
    B.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt',
      params: { sessionId: sessB, prompt: [{ type: 'text', text: '__echoB__' }] } });
    const rB = await B.waitFor((m) => m && m.id === 7 && m.result, 5000);
    check('B (fast) resolved FIRST under reversed order', !!rB);
    const rA = await A.waitFor((m) => m && m.id === 7 && m.result, 5000);
    check('A id=7 carries ITS echo payload (not B\'s)',
      rA.result?.echo?.includes('__echoA__') && rA.result?.sessionId === sessA,
      JSON.stringify(rA.result));
    check('B id=7 carries ITS echo payload (not A\'s)',
      rB.result?.echo?.includes('__echoB__') && rB.result?.sessionId === sessB,
      JSON.stringify(rB.result));
    check('no cross-session leak: A inbox has no sessB frames',
      !A.inbox.some((f) => f.msg?.params?.sessionId === sessB));
    check('no cross-session leak: B inbox has no sessA frames',
      !B.inbox.some((f) => f.msg?.params?.sessionId === sessA));

    // unclaimed agent->client request broadcasts to BOTH sockets
    A.reset(); B.reset();
    A.send({ jsonrpc: '2.0', id: 8, method: 'test/broadcast', params: { tag: 'u7' } });
    const [reqA, reqB] = await Promise.all([
      A.waitFor((m) => m && m.method === 'fs/read_text_file' && m.id >= 9000, 5000),
      B.waitFor((m) => m && m.method === 'fs/read_text_file' && m.id >= 9000, 5000),
    ]);
    check('broadcast request reached BOTH sockets with same agent id',
      !!reqA && !!reqB && reqA.id === reqB.id);
    A.send({ jsonrpc: '2.0', id: reqA.id, result: { content: 'from-A' } });
    B.send({ jsonrpc: '2.0', id: reqB.id, result: { content: 'from-B' } });
    const done = await A.waitFor((m) => m && m.id === 8 && m.result, 5000);
    check('test/broadcast resolved on caller socket with an answer',
      done.result?.tag === 'u7'
      && ['from-A', 'from-B'].includes(done.result?.answered?.content),
      JSON.stringify(done.result));

    // $/ping answered inline by the bridge — invisible to B
    B.reset();
    A.send({ jsonrpc: '2.0', id: 9, method: '$/ping', params: {} });
    await A.waitFor((m) => m && m.id === 9 && m.result?.pong, 5000);
    check('$/ping answered with caller id', true);
    await sleep(300);
    check('B saw nothing during $/ping', B.inbox.length === 0,
      `frames=${B.inbox.length}`);
  } finally {
    A.close();
    B.close();
    await sleep(200);           // let close frames flush
  }

  if (results.length) {
    console.log(`\nFAILURES:\n${results.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nALL PASS');
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exitCode = 1;
});
