#!/usr/bin/env node
// Mock ACP agent for e2e_bridge_replay_resume.mjs — a stdin/stdout NDJSON
// loop whose `session/load` replays a deterministic transcript so the
// bridge's acpUI tagging/suppression can be verified frame-for-frame.
//
//   session/load 'sess-grow' -> 12 chunks; the SECOND load for it streams
//                               the same 12 plus 4 appended (growth)
//   session/load 'sess-div'  -> 12 chunks; the second load streams a
//                               DIFFERENT transcript (divergence)
//   anything else            -> sensible ACP defaults
//
// Every received `session/load` param object is appended to the file named
// by argv[2] so the test can assert acpUIResume never reaches the agent.
import readline from 'node:readline';
import fs from 'node:fs';

const CHUNKS = 12;
const GROWN = 4;
const LOG = process.argv[2];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const chunk = (sessionId, kind, text) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: kind, content: { type: 'text', text } },
  },
});

const loadCounts = new Map();

function transcript(sid, generation) {
  const out = [];
  const total = sid === 'sess-grow' && generation > 1 ? CHUNKS + GROWN : CHUNKS;
  for (let i = 1; i <= total; i++) {
    const kind = i % 2 ? 'user_message_chunk' : 'agent_message_chunk';
    const text = sid === 'sess-div' && generation > 1
      ? `${sid} DIVERGED history ${i}`
      : `${sid} history ${i}`;
    out.push(chunk(sid, kind, text));
  }
  return out;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || typeof req.method !== 'string') return;
  if (req.id === undefined || req.id === null) return;
  const p = req.params || {};
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0', id: req.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          agentInfo: { name: 'resume-mock', version: '0' },
        },
      });
      break;
    case 'session/load': {
      if (LOG) fs.appendFileSync(LOG, JSON.stringify(p) + '\n');
      const sid = p.sessionId;
      const gen = (loadCounts.get(sid) ?? 0) + 1;
      loadCounts.set(sid, gen);
      for (const frame of transcript(sid, gen)) send(frame);
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      break;
    }
    default:
      send({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
