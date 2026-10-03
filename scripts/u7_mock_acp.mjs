// u7_mock_acp.mjs — deterministic mock ACP agent for bridge-level protocol
// proofs (U7). Speaks newline-delimited JSON-RPC 2.0 on stdio, which is the
// framing acp-ws-bridge uses (one complete line per WS frame).
//
// This fixture proves BRIDGE behaviour only — per-session routing of
// session/load replays and per-socket request-id namespacing on the shared
// child. It is NOT evidence of real CLI integration; Pi/Codex/Devin runs go
// through the managed porch runtime and are proven separately.
//
// Handled methods:
//   initialize        -> {protocolVersion, agentCapabilities, authMethods}
//   authenticate      -> {}
//   session/new       -> {sessionId: "mocksess-<n>", ...}
//   session/load      -> emits REPLAY transcript as session/update
//                        notifications on that sessionId, then {}
//   session/prompt    -> one agent_message_chunk echo, then {stopReason}
//                        prompt text "__slow__<ms>" delays the response so
//                        session/cancel can win the race (stopReason
//                        "cancelled").
//   session/cancel    -> notification; resolves a pending __slow__ prompt.
//
// Exit 0 on stdin EOF; 2 on malformed JSON lines (loud, not silent).

'use strict';

let seq = 0;
const pending = new Map(); // sessionId -> {resolve, timer}
let agentReqSeq = 9000;
const agentCalls = new Map(); // agent-side request id -> resolve(result)

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyErr(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function update(sessionId, sessionUpdate, extra = {}) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate, ...extra } },
  });
}

function replayTranscript(sessionId) {
  // Deterministic, distinguishable, ordered — the routing test asserts the
  // whole sequence lands on exactly the socket that issued session/load.
  update(sessionId, 'user_message_chunk', {
    content: { type: 'text', text: `replay-user:${sessionId}` },
  });
  update(sessionId, 'agent_message_chunk', {
    content: { type: 'text', text: `replay-agent-1:${sessionId}` },
  });
  update(sessionId, 'agent_message_chunk', {
    content: { type: 'text', text: `replay-agent-2:${sessionId}` },
  });
}

function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === undefined) {
    // A response to one of OUR agent->client requests — first answer wins;
    // a second socket's answer arrives after the call resolved (drop).
    const resolve = agentCalls.get(id);
    if (resolve) {
      agentCalls.delete(id);
      resolve(msg.result ?? msg.error ?? null);
    }
    return;
  }
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
      });
      return;
    case 'authenticate':
      reply(id, {});
      return;
    case 'session/new': {
      const sessionId = `mocksess-${++seq}`;
      reply(id, { sessionId, models: { currentModelId: 'mock-model-1' } });
      return;
    }
    case 'session/load': {
      const sessionId = params.sessionId;
      replayTranscript(sessionId);
      reply(id, {});
      return;
    }
    case 'session/prompt': {
      const sessionId = params.sessionId;
      const text = (params.prompt || [])
        .map((c) => (c && c.text) || '')
        .join(' ');
      const slow = /__slow__(\d+)?/.exec(text);
      update(sessionId, 'agent_message_chunk', {
        content: { type: 'text', text: `echo:${text.slice(0, 64)}` },
      });
      const finish = (stopReason) => {
        pending.delete(sessionId);
        // Per-request discriminator in the RESULT itself — the collision
        // test proves each socket gets ITS payload back, not just any id=7.
        reply(id, {
          stopReason,
          sessionId,
          echo: text.slice(0, 64),
        });
      };
      if (slow) {
        const timer = setTimeout(() => finish('end_turn'),
          Number(slow[1] || 30000));
        pending.set(sessionId, { finish, timer });
      } else {
        finish('end_turn');
      }
      return;
    }
    case 'session/cancel': {
      const p = pending.get(params.sessionId);
      if (p) {
        clearTimeout(p.timer);
        p.finish('cancelled');
      }
      return; // notification — no response
    }
    case 'test/broadcast': {
      // Emits a REAL agent->client request with NO sessionId in params —
      // per broadcast() an unclaimed frame must reach every socket. The
      // first client answer wins; the original caller gets the result.
      const aid = agentReqSeq++;
      send({
        jsonrpc: '2.0', id: aid,
        method: 'fs/read_text_file',
        params: { path: '/u7/broadcast-probe.txt' },
      });
      agentCalls.set(aid, (result) =>
        reply(id, { tag: params?.tag ?? null, answered: result }));
      return;
    }
    default:
      if (id !== undefined && id !== null) {
        replyErr(id, -32601, `mock: unsupported method ${method}`);
      }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`mock: malformed JSON line\n`);
      process.exit(2);
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
