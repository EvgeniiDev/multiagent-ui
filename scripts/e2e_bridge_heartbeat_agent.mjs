#!/usr/bin/env node
// Mock ACP agent for e2e_bridge_heartbeat.mjs — a stdin/stdout NDJSON loop.
//
//   initialize      -> capabilities (loadSession)
//   session/new     -> { sessionId: 'sess-new-<n>' }
//   session/load    -> a few session/update chunks for params.sessionId,
//                      then the response (fast — the point of these tests is
//                      what happens around the socket, not a long replay)
//   session/prompt  -> params.hang: NEVER respond, send nothing (wedged agent
//                      for the watchdog-vs-keepalive test)
//                      params.slow: drip chunks every SLOW_DRIP_MS until a
//                      session/cancel for that sessionId arrives, then answer
//                      { stopReason: 'cancelled' } (the steer test)
//                      otherwise: a few chunks + { stopReason: 'end_turn' }
//   session/cancel  -> notification. If a slow prompt is pending for
//                      params.sessionId it resolves 'cancelled'; otherwise a
//                      session/update echo goes out for that sessionId (the
//                      probe for "did the dead socket's claim get dropped" —
//                      a notification never claims a session, so the frame is
//                      only delivered by the broadcast fallback).
//   debug/seen      -> { methods: [...] } — every method this agent received,
//                      so the test can assert `$/`-frames never reach it.
//   anything else   -> {}
import readline from 'node:readline';

const LOAD_CHUNKS = 4;
const PROMPT_CHUNKS = 3;
const SLOW_DRIP_MS = 120;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const chunk = (sessionId, kind, text) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: kind, content: { type: 'text', text } },
  },
});

const seenMethods = [];
/** sessionId -> [{ id, timer }] — slow prompts waiting on cancel. */
const slowPrompts = new Map();
let newCounter = 0;

function startSlowPrompt(id, sessionId) {
  const entry = { id, n: 0, timer: null };
  entry.timer = setInterval(() => {
    entry.n += 1;
    send(chunk(sessionId, 'agent_message_chunk', `${sessionId} slow ${entry.n}`));
  }, SLOW_DRIP_MS);
  const list = slowPrompts.get(sessionId) ?? [];
  list.push(entry);
  slowPrompts.set(sessionId, list);
}

function cancelSlowPrompts(sessionId) {
  const list = slowPrompts.get(sessionId) ?? [];
  slowPrompts.delete(sessionId);
  for (const entry of list) {
    clearInterval(entry.timer);
    send({ jsonrpc: '2.0', id: entry.id, result: { stopReason: 'cancelled' } });
  }
  return list.length;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (!req || typeof req.method !== 'string') return;
  seenMethods.push(req.method);
  const p = req.params || {};
  if (req.id === undefined || req.id === null) {
    if (req.method === 'session/cancel' && typeof p.sessionId === 'string') {
      if (!cancelSlowPrompts(p.sessionId)) {
        // Nothing running — echo a frame so callers can probe whether the
        // sessionId is still claimed on the bridge.
        send(chunk(p.sessionId, 'agent_message_chunk', `${p.sessionId} cancel-echo`));
      }
    }
    return;
  }
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          agentInfo: { name: 'e2e-heartbeat-mock', version: '0' },
        },
      });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: req.id, result: { sessionId: `sess-new-${++newCounter}` } });
      break;
    case 'session/load': {
      for (let i = 1; i <= LOAD_CHUNKS; i++) {
        const kind = i % 2 ? 'user_message_chunk' : 'agent_message_chunk';
        send(chunk(p.sessionId, kind, `${p.sessionId} replay ${i}`));
      }
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      break;
    }
    case 'session/prompt': {
      if (p.hang) break; // a wedged agent: no chunks, no response, ever
      if (p.slow) {
        startSlowPrompt(req.id, p.sessionId);
        break;
      }
      for (let i = 1; i <= PROMPT_CHUNKS; i++) {
        send(chunk(p.sessionId, 'agent_message_chunk', `${p.sessionId} reply ${i}`));
      }
      send({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } });
      break;
    }
    case 'debug/seen':
      send({ jsonrpc: '2.0', id: req.id, result: { methods: seenMethods } });
      break;
    default:
      send({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
