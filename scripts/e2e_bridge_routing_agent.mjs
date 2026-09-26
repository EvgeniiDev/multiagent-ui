#!/usr/bin/env node
// Mock ACP agent for e2e_bridge_routing.mjs — a stdin/stdout NDJSON loop.
//
//   initialize    -> capabilities (loadSession + session/list)
//                    + one session/update for 'sess-nobody' (unclaimed
//                    session — the bridge must still broadcast it)
//   session/new   -> { sessionId: 'sess-<n>' }
//   session/list  -> { sessions: [] }
//   session/load  -> drip REPLAY_CHUNKS session/update frames for
//                    params.sessionId, then the response
//   session/prompt-> a few chunks for params.sessionId + { stopReason }
//   anything else -> {}
//
// The drip keeps `session/load` open while history streams, like a real
// agent — the whole point of the test is what the OTHER socket sees
// mid-replay.
import readline from 'node:readline';

const REPLAY_CHUNKS = 60;
const DRIP_MS = 20;
const PROMPT_CHUNKS = 3;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const chunk = (sessionId, kind, text) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: kind, content: { type: 'text', text } },
  },
});

let newCounter = 0;

function dripLoad(id, sessionId) {
  let i = 0;
  const tick = () => {
    if (i < REPLAY_CHUNKS) {
      i += 1;
      const kind = i % 2 ? 'user_message_chunk' : 'agent_message_chunk';
      send(chunk(sessionId, kind, `${sessionId} history ${i}`));
      setTimeout(tick, DRIP_MS);
    } else {
      send({ jsonrpc: '2.0', id, result: {} });
    }
  };
  tick();
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
  if (req.id === undefined || req.id === null) return; // notifications: no reply
  const p = req.params || {};
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
          authMethods: [],
          agentInfo: { name: 'e2e-mock', version: '0' },
        },
      });
      // A frame for a session nobody claimed — must still reach every client.
      send(chunk('sess-nobody', 'agent_message_chunk', 'unclaimed broadcast'));
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: req.id, result: { sessionId: `sess-new-${++newCounter}` } });
      break;
    case 'session/load':
      dripLoad(req.id, p.sessionId);
      break;
    case 'session/prompt': {
      for (let i = 1; i <= PROMPT_CHUNKS; i++) {
        send(chunk(p.sessionId, 'agent_message_chunk', `${p.sessionId} reply ${i}`));
      }
      send({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } });
      break;
    }
    case 'session/list':
      send({ jsonrpc: '2.0', id: req.id, result: { sessions: [] } });
      break;
    default:
      send({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
