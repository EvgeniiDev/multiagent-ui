#!/usr/bin/env node
// E2E: acpUI replay resume in deploy/acp-ws-bridge.mjs.
//
// One bridge, one mock agent (e2e_replay_resume_agent.mjs) streaming a
// deterministic transcript. Asserts:
//   * every replayed session/update carries _meta.acpUI {seq,hh} in order
//   * a second load with acpUIResume {seq,hh} gets only the suffix;
//     result._meta.acpUI.skipped reports the withheld count
//   * the resume token is STRIPPED — the agent's params never contain it
//   * growth keeps the prefix identical: resume still verifies
//   * divergence makes the hash check fail at seq → the bridge flushes the
//     buffered frames with resync:true on the first and forwards all
//   * a resumeSeq beyond the stream flushes with resync at finalize
//
// Usage: node scripts/e2e_bridge_replay_resume.mjs

import { testEnv, stopTestBridge } from './bridge-test-harness.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'deploy', 'acp-ws-bridge.mjs');
const AGENT = path.join(ROOT, 'scripts', 'e2e_replay_resume_agent.mjs');
const CHUNKS = 12;
const capCase = process.env.TEST_REPLAY_BUFFER_CAP === '1';

const results = [];
function check(name, ok, extra = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}

function loadWs() {
  const req = createRequire(import.meta.url);
  const guesses = [
    'ws',
    `${os.homedir()}/.local/lib/node_modules/ws`,
    '/usr/local/lib/node_modules/ws',
    '/usr/lib/node_modules/ws',
  ];
  for (const g of guesses) {
    try { const mod = req(g); return { mod, entry: req.resolve(g) }; } catch { /* next */ }
  }
  throw new Error("cannot resolve the 'ws' module — set NODE_PATH and retry");
}
const { mod: wsModule, entry: wsEntry } = loadWs();
const { WebSocket } = wsModule;
const WS_NODE_MODULES = wsEntry.includes(`${path.sep}node_modules${path.sep}`)
  ? wsEntry.split(`${path.sep}node_modules${path.sep}`)[0] + `${path.sep}node_modules`
  : path.dirname(wsEntry);

class Client {
  constructor(port) {
    this.ws = null;
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
    this.frames = [];
  }
  open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/`);
    this.ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }
        this.frames.push(msg);
        if (msg.id !== undefined && msg.method === undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        }
      }
    });
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20000).unref?.();
    });
  }
  updates(sid, since = 0) {
    return this.frames.slice(since).filter(
      (f) => f.method === 'session/update' && f.params?.sessionId === sid);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-resume-'));
  const paramLog = path.join(temp, 'load-params.log');
  const env = await testEnv(temp, 'docker');
  const bridge = spawn(
    process.execPath,
    [BRIDGE, '--port', '0', '--bind', '127.0.0.1', '--required-mode', 'docker',
     '--cmd', `${process.execPath} ${AGENT} ${paramLog}`, '--root', os.tmpdir()],
    { env: { ...env, NODE_PATH: WS_NODE_MODULES, ACP_TOKEN_METER: '0', ...(capCase ? { ACP_REPLAY_BUFFER_CAP_BYTES: '128' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('bridge never listened')), 10000);
      bridge.stdout.on('data', (d) => {
        output += d.toString();
        if (d.toString().includes('listening')) { clearTimeout(to); resolve(); }
      });
      bridge.once('exit', (c) => reject(new Error(`bridge exited early code=${c}`)));
    });
  } catch (error) {
    await stopTestBridge(bridge); await rm(temp, { recursive: true, force: true }); throw error;
  }
  const port = Number(output.match(/listening on :(\d+)/)[1]);
  const c = new Client(port);
  try {
    await c.open();
    await c.call('initialize', { protocolVersion: 1 });

    // --- First load: every replayed frame tagged in order ---------------
    const r1 = await c.call('session/load', { sessionId: 'sess-grow' });
    const first = c.updates('sess-grow');
    check('first load: all frames replayed', first.length === CHUNKS, `${first.length}/${CHUNKS}`);
    const tagsOk = first.every((f, i) =>
      f.params?._meta?.acpUI?.seq === i + 1 && typeof f.params._meta.acpUI.hh === 'string' && f.params._meta.acpUI.hh.length === 64);
    check('first load: every frame tagged {seq,hh} in order', tagsOk);
    check('first load: result carries acpUI summary', r1?._meta?.acpUI?.frames === CHUNKS && r1._meta.acpUI.skipped === 0,
      JSON.stringify(r1?._meta?.acpUI));
    const chainDistinct = new Set(first.map((f) => f.params._meta.acpUI.hh)).size === CHUNKS;
    check('first load: rolling hash advances per frame', chainDistinct);
    const token = { seq: 8, hh: first[7].params._meta.acpUI.hh };

    if (capCase) {
      const before = c.frames.length;
      const result = await c.call('session/load', { sessionId: 'sess-grow', acpUIResume: token });
      const frames = c.updates('sess-grow', before);
      check('buffer cap: full transcript is delivered even when the later hash matches', frames.length === CHUNKS + 4);
      check('buffer cap: resync never reports a skipped prefix', result._meta.acpUI.resynced && result._meta.acpUI.skipped === 0);
      check('buffer cap: first frame instructs client to rebuild', frames[0]?.params?._meta?.acpUI?.resync === true);
      process.exitCode = results.some(([, ok]) => !ok) ? 1 : 0;
      return;
    }

    // --- Second load, growth: resume at 8, suffix 9..16 forwards ---------
    const before2 = c.frames.length;
    const r2 = await c.call('session/load', {
      sessionId: 'sess-grow', acpUIResume: token,
    });
    const second = c.updates('sess-grow', before2);
    check('resumed load: only the suffix arrives',
      second.length === CHUNKS + 4 - token.seq, `${second.length} frames`);
    check('resumed load: suffix seqs continue past the resume point',
      second.every((f, i) => f.params?._meta?.acpUI?.seq === token.seq + 1 + i));
    check('resumed load: no resync flag on the suffix',
      second.every((f) => f.params._meta.acpUI.resync !== true));
    check('resumed load: result reports withheld prefix',
      r2?._meta?.acpUI?.skipped === token.seq && r2._meta.acpUI.resynced === false,
      JSON.stringify(r2?._meta?.acpUI));
    check('resumed load: tail text is the grown transcript tail',
      second.at(-1)?.params?.update?.content?.text === `sess-grow history ${CHUNKS + 4}`);

    // --- Diverged transcript: hash mismatch at seq -> resync flush -------
    await c.call('session/load', { sessionId: 'sess-div' });
    const divFirst = c.updates('sess-div');
    const divToken = { seq: 8, hh: divFirst[7].params._meta.acpUI.hh };
    const before3 = c.frames.length;
    const r3 = await c.call('session/load', {
      sessionId: 'sess-div', acpUIResume: divToken,
    });
    const third = c.updates('sess-div', before3);
    check('diverged load: every frame forwarded after mismatch', third.length === CHUNKS, `${third.length}`);
    check('diverged load: first frame flagged resync', third[0]?.params?._meta?.acpUI?.resync === true);
    check('diverged load: result reports resync + nothing skipped',
      r3?._meta?.acpUI?.resynced === true && r3._meta.acpUI.skipped === 0,
      JSON.stringify(r3?._meta?.acpUI));

    // --- Resume past the end: stream shorter than seq -> finalize flush --
    const before4 = c.frames.length;
    const r4 = await c.call('session/load', {
      sessionId: 'sess-div', acpUIResume: { seq: 999, hh: 'whatever' },
    });
    const fourth = c.updates('sess-div', before4);
    check('short stream: buffered frames flush at finalize', fourth.length === CHUNKS, `${fourth.length}`);
    check('short stream: first flushed frame flagged resync', fourth[0]?.params?._meta?.acpUI?.resync === true);
    check('short stream: result reports resync', r4?._meta?.acpUI?.resynced === true);

    // --- The agent never saw the extension param -------------------------
    const seen = (await readFile(paramLog, 'utf8')).trim().split('\n').map(JSON.parse);
    check('agent params never contain acpUIResume', seen.every((p) => p.acpUIResume === undefined),
      `${seen.length} loads logged`);
  } finally {
    c.close();
    await stopTestBridge(bridge);
    await rm(temp, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
