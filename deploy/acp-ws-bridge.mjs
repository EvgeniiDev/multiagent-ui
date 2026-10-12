#!/usr/bin/env node
// ACP stdio <-> WebSocket bridge with newline-framed buffering + a small
// filesystem-listing HTTP API for the acp-ui directory tree picker.
//
// Why this exists instead of @rebornix/stdio-to-ws: that bridge forwards each
// raw child-stdout chunk as one WebSocket frame. Any JSON-RPC line larger than
// the pipe buffer (64 KiB) therefore arrives split mid-JSON across two frames,
// and ACP clients that parse one JSON-RPC frame per WS message (acp-ui's
// WebSocketTransport does exactly this) silently drop it — the request then
// hangs until its 60s timeout. Pi's session/new carries a ~113 KB model
// catalog, which triggers it reliably.
//
// This bridge instead buffers stdout and emits exactly one complete line per
// WS frame, and appends the '\n' the agent's stdin reader needs on the way in.
//
// The HTTP API (same port as the WebSocket) lets the web UI show a directory
// tree rooted at --root (default: the agent user's home directory):
//   GET /api/fs/root                -> { root, home }
//   GET /api/fs/list?path=...       -> { path, parent, dirs: [{name, path}] }
//   GET /api/fs/list?path=...&hidden=1   (include dot-directories)
// Listing is scoped to the root subtree.
//
// Request watchdog: ACP requests (session/prompt above all) routinely run for
// many minutes, so a fixed wall-clock timeout abandons healthy turns. This
// bridge instead watches TRAFFIC — any JSON-RPC frame in either direction is
// progress — and fails pending requests only after the wire has been silent
// for --idle-timeout-ms (default 180000, env ACP_IDLE_TIMEOUT_MS). A request
// that times out this way is answered with a JSON-RPC error reading
// "no traffic for Ns"; a child that dies is reported as "agent CLI exited".
// The two failure modes are therefore distinguishable in the log and in the
// panel's traffic monitor.
//
// Token meter (estimate): the bridge sees every JSON-RPC frame either way,
// so agents that never emit `usage_update` (Devin, Pi) still get coverage —
// the bridge counts user-text characters on `session/prompt` (client->agent)
// and reply text on `agent_message_chunk`/`user_message_chunk`/
// `agent_thought_chunk` (agent->client), then writes a running-total sample
// into the shared activity.json ledger tagged `source:"estimate"`. The panel
// renders those with a `~` mark and always prefers exact agent numbers for
// the same session. ~4 chars per token is a latin/code heuristic; Cyrillic
// packs denser. All of it is best-effort: metering never throws into the
// data path and never blocks a frame.
//
// Per-session routing: one child process serves every WebSocket client, so
// without it a `session/load` replay in one tab is delivered to ALL tabs —
// the other tab renders foreign chunks into its open chat and drowns under
// the traffic. Each socket claims the sessionId it last drove through
// `session/load`/`session/prompt`, or `session/new` (that id only exists in
// the response, so the claim lands when it resolves). Inbound frames that
// name a claimed `params.sessionId` go to the owning socket only; everything
// sessionless or unclaimed is broadcast to all clients exactly as before.
//
// Request ids are namespaced per socket: every client starts numbering at
// 0, so two tabs' `id:2` requests on the shared child are indistinguishable
// — a broadcast response would resolve BOTH pending calls (verified: one
// tab's session/new resolved the other's in-flight session/load). Outbound
// request ids are rewritten to a bridge-unique number on the way to the
// child and restored on the way back, and the response is delivered only to
// the socket that asked.
//
// Usage: node acp-ws-bridge.mjs --port 25901 --cmd "hermes acp" [--root /home/x]
//        [--idle-timeout-ms 180000] [--agent-name "Hermes Agent"]
//        [--defer-load-on-prompt]
// Env:   ACP_TOKEN_METER=0 disables metering (default on),
//        ACP_STATE_URL=http://127.0.0.1:25900 state server for the ledger,
//        ACP_TOKEN_METER_INTERVAL_MS=10000 min write interval per session.
import { BridgeProcessOwner } from './bridge-process-owner.mjs';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const port = Number(argValue('--port', ''));
const command = String(argValue('--cmd', '') || '').trim();
const root = path.resolve(String(argValue('--root', os.homedir())));
const home = os.homedir();

// --defer-load-on-prompt: queue a session/load|resume for a session whose
// session/prompt is still in flight instead of forwarding it immediately —
// see deferredLoads for why. Devin needs it (its load rebuilds the session
// agent and kills the live turn); agents whose load merely resumes a live
// turn must NOT have their open-tab stalled, so it stays opt-in there.
// Auto-enabled when the wrapped command is devin — a plain container restart
// picks up the fix without a compose recreate.
const DEFER_LOAD_DURING_PROMPT =
  process.argv.includes('--defer-load-on-prompt') ||
  (process.env.ACP_DEFER_LOAD_ON_PROMPT ?? '0') === '1' ||
  /\bdevin\b/.test(command);

if (!Number.isInteger(port) || port <= 0 || !command) {
  console.error('usage: acp-ws-bridge.mjs --port <port> --cmd "<command>" [--root <dir>]');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Token meter — bridge-side estimate for agents that do not report usage.
// ---------------------------------------------------------------------------

const TOKEN_METER = (process.env.ACP_TOKEN_METER ?? '1') !== '0';
const METER_STATE_URL = (process.env.ACP_STATE_URL || 'http://127.0.0.1:25900').replace(/\/+$/, '');
const METER_INTERVAL_MS = Number(process.env.ACP_TOKEN_METER_INTERVAL_MS || 10_000);
const CHARS_PER_TOKEN = 4;
const METER_MAX_USAGE = 5000;
const METER_RETRIES = 6;

// Agent display names keyed by the bridge command's binary — the systemd
// units pass no flag, so the label matches the panel's agent names by default.
const AGENT_NAME_BY_CMD = {
  devin: 'Devin',
  'pi-acp': 'Pi',
  pi: 'Pi',
  hermes: 'Hermes Agent',
  opencode: 'OpenCode',
  'codex-acp': 'Codex',
  codex: 'Codex',
};
const METER_AGENT_NAME = String(
  argValue('--agent-name', AGENT_NAME_BY_CMD[command.split(/\s+/)[0]] ?? command.split(/\s+/)[0])
);

/** sessionId -> { cwd?, chars, lastWriteAt, lastWrittenUsed, lastWrittenModel, writing, agentReports, model? } */
const meterSessions = new Map();
/** request id -> cwd, for `session/new` requests awaiting their response. */
const meterNewReqs = new Map();
/** request id -> sessionId, for `session/load` requests awaiting their
 * response — the response may carry the session's model like new does. */
const meterLoadReqs = new Map();
/** request id -> sessionId, for `session/prompt` requests awaiting their
 * response — the turn's end is the natural moment to flush the estimate. */
const meterPromptReqs = new Map();

function meterSession(sessionId, cwd) {
  let s = meterSessions.get(sessionId);
  if (!s) {
    s = { cwd, chars: 0, lastWriteAt: 0, lastWrittenUsed: -1, lastWrittenModel: undefined, writing: false, agentReports: false, model: undefined };
    meterSessions.set(sessionId, s);
  }
  if (cwd && !s.cwd) s.cwd = cwd;
  return s;
}

/**
 * The session's announced model, straight off a `session/new` or
 * `session/load` result. Two real shapes exist on the wire (probed
 * 2026-09-25): `models.currentModelId` (Hermes, Pi) and a `configOptions`
 * select with category/id `model` carrying `currentValue` (OpenCode, Devin —
 * which publish no `models` block at all). Returns undefined when neither is
 * present — the estimate then records an honest 'unknown'.
 */
function meterModelFromResult(result) {
  const direct = result?.models?.currentModelId;
  if (typeof direct === 'string' && direct) return direct;
  const opts = result?.configOptions;
  if (Array.isArray(opts)) {
    const opt = opts.find(
      (o) => o && (o.category === 'model' || o.id === 'model') && typeof o.currentValue === 'string'
    );
    if (opt?.currentValue) return opt.currentValue;
  }
  return undefined;
}

/** Characters in an ACP content block or prompt-part array — text only. */
function meterTextLen(content) {
  if (!content) return 0;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + meterTextLen(b), 0);
  }
  if (typeof content === 'object' && content.type === 'text' && typeof content.text === 'string') {
    return content.text.length;
  }
  return 0;
}

/** client -> agent frames that carry countable text or session metadata. */
function meterOutbound(msg) {
  if (!msg || typeof msg.method !== 'string') return;
  const p = msg.params || {};
  switch (msg.method) {
    case 'session/new':
      if (msg.id !== undefined && msg.id !== null) meterNewReqs.set(msg.id, p.cwd);
      break;
    case 'session/load':
      if (typeof p.sessionId === 'string') {
        meterSession(p.sessionId, p.cwd);
        if (msg.id !== undefined && msg.id !== null) meterLoadReqs.set(msg.id, p.sessionId);
      }
      break;
    case 'session/set_model':
      // The client switched the session's model mid-flight — later estimates
      // carry the new id.
      if (typeof p.sessionId === 'string' && typeof p.modelId === 'string') {
        meterSession(p.sessionId).model = p.modelId;
      }
      break;
    case 'session/set_config_option':
      // Agents that expose the model as a config option (OpenCode, Devin)
      // take model changes through this method instead of set_model.
      if (typeof p.sessionId === 'string' && p.configId === 'model' && typeof p.value === 'string') {
        meterSession(p.sessionId).model = p.value;
      }
      break;
    case 'session/prompt': {
      if (typeof p.sessionId !== 'string') return;
      const s = meterSession(p.sessionId, p.cwd);
      s.chars += meterTextLen(p.prompt);
      if (msg.id !== undefined && msg.id !== null) meterPromptReqs.set(msg.id, p.sessionId);
      meterMaybeWrite(p.sessionId, s);
      break;
    }
  }
}

/** agent -> client frames: chunk text is reply surface; `usage_update` means
 * the agent reports exact numbers itself and the shadow estimate stands down. */
function meterInbound(msg) {
  if (!msg) return;
  if (typeof msg.method === 'string') {
    if (msg.method !== 'session/update') return;
    const p = msg.params || {};
    const sessionId = p.sessionId;
    if (typeof sessionId !== 'string') return;
    const update = p.update || {};
    if (update.sessionUpdate === 'usage_update') {
      meterSession(sessionId).agentReports = true;
      return;
    }
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'user_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      const s = meterSession(sessionId);
      s.chars += meterTextLen(update.content);
      meterMaybeWrite(sessionId, s);
    }
    return;
  }
  // A response frame: correlate by id to learn sessionIds / flush on turn end.
  if (msg.id === undefined || msg.id === null) return;
  if (meterNewReqs.has(msg.id)) {
    const cwd = meterNewReqs.get(msg.id);
    meterNewReqs.delete(msg.id);
    const sid = msg.result?.sessionId;
    if (typeof sid === 'string') {
      const s = meterSession(sid, cwd);
      s.model = meterModelFromResult(msg.result) ?? s.model;
    }
    return;
  }
  if (meterLoadReqs.has(msg.id)) {
    const sid = meterLoadReqs.get(msg.id);
    meterLoadReqs.delete(msg.id);
    const s = meterSession(sid);
    s.model = meterModelFromResult(msg.result) ?? s.model;
    return;
  }
  if (meterPromptReqs.has(msg.id)) {
    const sessionId = meterPromptReqs.get(msg.id);
    meterPromptReqs.delete(msg.id);
    meterFlush(sessionId);
  }
}

function meterMaybeWrite(sessionId, s) {
  if (!TOKEN_METER || s.agentReports) return;
  if (Date.now() - s.lastWriteAt < METER_INTERVAL_MS) return;
  meterFlush(sessionId, s);
}

/** Fire-and-forget ledger write; serialized per session, never awaited on
 * the wire path and never thrown out of a message handler. */
function meterFlush(sessionId, s) {
  if (!TOKEN_METER) return;
  s = s ?? meterSessions.get(sessionId);
  if (!s || s.writing || s.agentReports) return;
  const used = Math.ceil(s.chars / CHARS_PER_TOKEN);
  // A model switch alone (used unchanged) still earns a row — same rule the
  // panel store applies.
  const model = s.model ?? 'unknown';
  if (used <= 0 || (used === s.lastWrittenUsed && model === s.lastWrittenModel)) return;
  s.writing = true;
  meterAppend({
    at: Date.now(),
    agentName: METER_AGENT_NAME,
    sessionId,
    cwd: s.cwd,
    used,
    size: 0,
    source: 'estimate',
    // `models.currentModelId` / the model config option as the agent announced
    // it; the wire carries no structured provider, so 'unknown' it stays.
    model,
    provider: 'unknown',
  })
    .then((wrote) => {
      s.lastWriteAt = Date.now();
      if (wrote) {
        s.lastWrittenUsed = used;
        s.lastWrittenModel = model;
      }
    })
    .catch((e) => log('token-meter write failed:', e instanceof Error ? e.message : e))
    .finally(() => {
      s.writing = false;
    });
}

/** Append one sample to activity.json -> usage[] via the shared rev protocol
 * (GET -> mutate -> PUT with rev, retry on 409 — same as the runner's
 * mutate()). Dedupes a repeat of the session's last identical sample. */
async function meterAppend(sample) {
  for (let i = 0; i < METER_RETRIES; i++) {
    const got = await fetch(`${METER_STATE_URL}/api/state/activity.json`).catch(() => null);
    if (!got) return false;
    let doc = { entries: [], usage: [] };
    let rev = 0;
    if (got.status === 200) {
      const body = await got.json().catch(() => null);
      if (body && typeof body === 'object') {
        doc = body.data && typeof body.data === 'object' ? body.data : doc;
        rev = Number(body.rev) || 0;
      }
    } else if (got.status !== 404) {
      return false;
    }
    if (!Array.isArray(doc.usage)) doc.usage = [];
    const last = [...doc.usage].reverse().find((u) => u && u.sessionId === sample.sessionId && (u.source ?? 'agent') === 'estimate');
    if (
      last &&
      last.used === sample.used &&
      (last.model ?? 'unknown') === (sample.model ?? 'unknown') &&
      (last.provider ?? 'unknown') === (sample.provider ?? 'unknown')
    )
      return true; // nothing new to say
    doc.usage = [...doc.usage.slice(-(METER_MAX_USAGE - 1)), sample];
    const put = await fetch(`${METER_STATE_URL}/api/state/activity.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: doc, rev }),
    }).catch(() => null);
    if (!put) return false;
    if (put.status === 200) return true;
    if (put.status === 409) {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    return false;
  }
  return false;
}


// ---------------------------------------------------------------------------
// HTTP filesystem API (for the acp-ui tree picker)
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(obj));
}

/** Resolve a (possibly relative) path against the bridge root and report
 * whether it stays inside the root subtree. */
function resolveScoped(p) {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
  const inside = abs === root || abs.startsWith(root + path.sep);
  return { abs, inside };
}

/** Text reads/writes are for role prompts and card artefacts, not for blobs;
 * past this size the panel must hand the path to an agent instead. */
const MAX_TEXT_BYTES = 512 * 1024;

function listDirs(abs, hidden) {
  const dirents = fs.readdirSync(abs, { withFileTypes: true });
  const dirs = [];
  for (const d of dirents) {
    if (!hidden && d.name.startsWith('.')) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(abs, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) dirs.push({ name: d.name, path: path.join(abs, d.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return dirs;
}

function handleHttp(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // POST /api/fs/mkdir  { path } -> create a directory tree inside root.
  // The panel's project registry needs this: a project is just a folder, and the
  // browser build has no filesystem access of its own. Scoped exactly like
  // /api/fs/list, so it can never write outside root.
  if (u.pathname === '/api/fs/mkdir') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    let raw = '';
    let aborted = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) {
        json(res, 413, { error: 'body too large' });
        return;
      }
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        json(res, 400, { error: 'invalid json' });
        return;
      }
      const target = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!target) {
        json(res, 400, { error: 'path required' });
        return;
      }
      const { abs, inside } = resolveScoped(target);
      if (!inside) {
        json(res, 403, { error: `path outside root: ${abs}` });
        return;
      }
      try {
        const existed = fs.existsSync(abs);
        fs.mkdirSync(abs, { recursive: true });
        json(res, 200, { path: abs, created: !existed });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }

  // POST /api/fs/write  { path, content } -> write a text file inside root.
  // Role prompts (`.acp/roles/<role>.md`) and per-card artefacts live in the
  // project directory, and the browser build can only reach the filesystem
  // through this API. Scoped like the other fs routes; the write goes through a
  // temp file plus rename so a reader never sees a half-written prompt.
  if (u.pathname === '/api/fs/write') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    let raw = '';
    let aborted = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_TEXT_BYTES * 2) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) {
        json(res, 413, { error: 'body too large' });
        return;
      }
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        json(res, 400, { error: 'invalid json' });
        return;
      }
      const target = typeof body?.path === 'string' ? body.path.trim() : '';
      const content = typeof body?.content === 'string' ? body.content : null;
      if (!target || content === null) {
        json(res, 400, { error: 'path and content required' });
        return;
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_TEXT_BYTES) {
        json(res, 413, { error: `content exceeds ${MAX_TEXT_BYTES} bytes` });
        return;
      }
      const { abs, inside } = resolveScoped(target);
      if (!inside) {
        json(res, 403, { error: `path outside root: ${abs}` });
        return;
      }
      try {
        const existed = fs.existsSync(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, abs);
        json(res, 200, { path: abs, created: !existed, bytes });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (u.pathname === '/api/fs/root') {
    json(res, 200, { root, home });
    return;
  }

  if (u.pathname === '/api/fs/list') {
    const p = u.searchParams.get('path') || root;
    const hidden = u.searchParams.get('hidden') === '1';
    const { abs, inside } = resolveScoped(p);
    if (!inside) {
      json(res, 403, { error: `path outside root: ${abs}` });
      return;
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isDirectory()) {
        json(res, 400, { error: `not a directory: ${abs}` });
        return;
      }
      json(res, 200, { path: abs, parent: path.dirname(abs), root, dirs: listDirs(abs, hidden) });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  // GET /api/fs/read?path=<abs> -> { path, bytes, content } for a text file.
  // Pairs with /api/fs/write: the panel shows and edits a role prompt that
  // lives in the project directory. Binary files and blobs are refused by
  // sniffing a NUL byte and by size, not by guessing from the extension.
  if (u.pathname === '/api/fs/read') {
    const p = u.searchParams.get('path') || '';
    if (!p) {
      json(res, 400, { error: 'path required' });
      return;
    }
    const { abs, inside } = resolveScoped(p);
    if (!inside) {
      json(res, 403, { error: `path outside root: ${abs}` });
      return;
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        json(res, 400, { error: `not a file: ${abs}` });
        return;
      }
      if (st.size > MAX_TEXT_BYTES) {
        json(res, 413, { error: `file exceeds ${MAX_TEXT_BYTES} bytes` });
        return;
      }
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) {
        json(res, 415, { error: 'binary file' });
        return;
      }
      json(res, 200, { path: abs, bytes: st.size, content: buf.toString('utf8') });
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        json(res, 404, { error: `not found: ${abs}` });
        return;
      }
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// WebSocket -> child stdin/stdout plumbing
// ---------------------------------------------------------------------------

const clients = new Set();
const processOwner = new BridgeProcessOwner();
let buffer = '';

/** sessionId -> ws that owns it: the socket that last sent session/load or
 * session/prompt for it, or whose session/new response named it. Inbound
 * frames carrying a claimed sessionId are routed to the owner only. */
const sessionOwner = new Map();
/** Bridge-unique request ids — see the routing note above. Every outbound
 * client request gets one on the way to the child; the response carries it
 * back to the owning socket, with the caller's original id restored. */
let nextBridgeId = 1;

// ---------------------------------------------------------------------------
// Progress-aware request watchdog
// ---------------------------------------------------------------------------
// The panel used to abandon every RPC after a fixed 60 s, so a long agent turn
// was reported as failed while the agent was still working — and a resend
// duplicated the work. The watchdog fails a request only when the wire has
// been SILENT for IDLE_TIMEOUT_MS: every frame in either direction is progress
// and pushes the deadline out. While the agent is itself waiting on the client
// (an unanswered agent->client request such as session/request_permission or
// fs/read_text_file), silence is expected and the watchdog stands down; the
// client's own answer is what re-arms the clock.
const IDLE_TIMEOUT_MS = Number(
  argValue('--idle-timeout-ms', process.env.ACP_IDLE_TIMEOUT_MS || 180_000)
);
const WATCHDOG_TICK_MS = Math.min(30_000, Math.max(500, Math.floor(IDLE_TIMEOUT_MS / 4)));
/** client -> agent requests awaiting a response: BRIDGED id ->
 * { method, ws, origId }. The bridged id is what the child sees; origId is
 * what the requesting socket sent and gets restored into the response. */
const pendingClientReqs = new Map();
/** agent -> client requests awaiting our response (agent is blocked on us):
 * bridged id -> { line, sid }. The raw frame is kept so a client that just
 * connected can be handed a request it never saw (deferLoad re-broadcast). */
const pendingAgentReqs = new Map();
let lastTrafficAt = Date.now();

/** sessionId -> queued { ws, line } `session/load`/`session/resume` frames
 * held back while that session has a `session/prompt` in flight. Devin's acp
 * server answers a load by REBUILDING the session agent: the in-flight prompt
 * then fails with "Agent communication channel closed" and the turn dies.
 * Verified 2026-10-09 (devin 3000.11.3): a second client's session/load kills
 * the running turn outright — no updates ever follow. Since every reconnect
 * (page reload, second device, auto-reconnect after a socket drop) replays
 * `session/load` unconditionally, each flap used to murder every live Devin
 * turn. Holding the load until the prompt settles keeps the turn alive — the
 * reconnecting tab just finishes connecting when the turn ends. */
const deferredLoads = new Map();

/** True while a `session/prompt` request for `sid` is unanswered. */
function promptInFlight(sid) {
  for (const req of pendingClientReqs.values()) {
    if (req.method === 'session/prompt' && req.sid === sid) return true;
  }
  return false;
}

/** Hold a session/load|resume frame until the session's prompt settles. */
function deferLoad(sid, ws, line) {
  let q = deferredLoads.get(sid);
  if (!q) {
    q = [];
    deferredLoads.set(sid, q);
  }
  q.push({ ws, line });
  log(`deferring session load for ${sid} — prompt in flight (${q.length} queued)`);
  // The turn may be waiting on an agent->client request (permission prompt,
  // fs/read_text_file) that was broadcast before this socket existed — replay
  // it so the loading client can answer and let the turn finish instead of
  // both sides waiting forever.
  for (const req of pendingAgentReqs.values()) {
    if (req.sid === sid) {
      try {
        ws.send(req.line);
      } catch {
        /* socket dying — the close handler cleans up */
      }
    }
  }
}

/** Forward queued loads whose sessions no longer have an in-flight prompt.
 * With a `sid` argument only that session is checked; without, all queued
 * sessions (used by the close handler, where a dead socket may have held the
 * last pending prompt). */
function flushDeferredLoads(sid) {
  const sids = sid ? [sid] : [...deferredLoads.keys()];
  for (const s of sids) {
    const q = deferredLoads.get(s);
    if (!q) continue;
    deferredLoads.delete(s);
    if (promptInFlight(s)) {
      // A newer prompt started since this queue formed — keep waiting.
      deferredLoads.set(s, q);
      continue;
    }
    for (const entry of q) {
      const ws = entry.ws;
      if (!clients.has(ws) || ws.readyState !== 1) continue;
      try {
        const out = noteOutbound(entry.line + '\n', ws);
        if (out) {
          if (!processOwner.current) spawnChild();
          processOwner.current.stdin.write(out);
        }
        log(`released deferred session load for ${s}`);
      } catch (e) {
        log('deferred load forward failed:', e.message);
      }
    }
  }
}

/** Any frame on the wire — request, response, or notification — is progress. */
function noteTraffic() {
  lastTrafficAt = Date.now();
}

/** Track a client -> agent frame and return the payload to write to the
 * child. A WS message can carry several NDJSON lines, so each is parsed on
 * its own; requests get their id rewritten to a bridge-unique number (the
 * only way two sockets' `id:2` stay distinguishable on the shared child)
 * and are recorded for the watchdog + response routing. Session-driving
 * requests also claim their sessionId for per-session routing (see
 * sessionOwner). Unparseable lines pass through verbatim.
 *
 * `$/ping` heartbeat frames are answered HERE, inside the per-line loop —
 * never forwarded to the child and never counted as traffic (a keepalive
 * every 25 s would re-arm lastTrafficAt forever and mask a genuinely
 * wedged agent from the watchdog). A `$/pong` goes straight to the asking
 * socket with a bare ws.send — never through broadcast(), so it cannot
 * leak into another tab. Intercepting in ws.on('message') instead would
 * break multi-line payloads, so it must stay inside this loop. */
function noteOutbound(payload, ws) {
  const out = [];
  for (const line of payload.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg = null;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      out.push(trimmed);
      continue;
    }
    if (msg && msg.method === '$/ping') {
      try {
        if (msg.id !== undefined && msg.id !== null) {
          // Request form: answer with the caller's own id — nothing is
          // forwarded to the shared child, so no bridged id is consumed and
          // pendingClientReqs stays clean.
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }));
        } else {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', method: '$/pong',
            params: {
              ...(msg.params && typeof msg.params === 'object' ? msg.params : {}),
              ts: Date.now(),
            },
          }));
        }
      } catch {
        /* socket dying — the close handler cleans up */
      }
      continue;
    }
    if (msg && DEFER_LOAD_DURING_PROMPT &&
        (msg.method === 'session/load' || msg.method === 'session/resume')) {
      const sid = msg.params?.sessionId;
      if (typeof sid === 'string' && promptInFlight(sid)) {
        // Queue, don't forward — the in-flight turn survives; this frame
        // reaches the child when the prompt settles (flushDeferredLoads).
        // Deferral happens BEFORE the request-id rewrite, so the stored line
        // still carries the caller's original id.
        deferLoad(sid, ws, trimmed);
        continue;
      }
    }
    if (msg && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      const bridged = nextBridgeId++;
      const sid = msg.params?.sessionId;
      pendingClientReqs.set(bridged, {
        method: msg.method, ws, origId: msg.id,
        sid: typeof sid === 'string' ? sid : undefined,
      });
      msg.id = bridged;
      if (typeof sid === 'string' &&
          (msg.method === 'session/load' || msg.method === 'session/prompt')) {
        sessionOwner.set(sid, ws);
      }
      try {
        meterOutbound(msg);
      } catch {
        /* metering must never break the pipe */
      }
      out.push(JSON.stringify(msg));
      continue;
    }
    if (msg && msg.id !== undefined && msg.id !== null) {
      // A response to an agent -> client request (e.g. a permission answer)
      // — the agent's own id, passed through untouched.
      pendingAgentReqs.delete(msg.id);
    }
    try {
      meterOutbound(msg);
    } catch {
      /* metering must never break the pipe */
    }
    out.push(trimmed);
  }
  // Only frames actually forwarded to the agent count as traffic — a payload
  // that was all `$/ping` keepalives must not re-arm the watchdog clock.
  if (out.length > 0) noteTraffic();
  return out.length ? out.join('\n') + '\n' : '';
}

/** Track an agent -> client frame: clears a pending request when the response
 * lands (restoring the caller's original id and naming the socket to answer),
 * and registers agent-originated requests while they await our answer.
 * Returns { msg, dest } so the caller can route the frame. */
function noteInbound(line) {
  noteTraffic();
  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    return { msg: null, dest: null };
  }
  try {
    meterInbound(msg);
  } catch {
    /* metering must never break the pipe */
  }
  if (!msg || msg.id === undefined || msg.id === null) return { msg, dest: null };
  if (typeof msg.method === 'string') {
    const sid = msg.params?.sessionId;
    pendingAgentReqs.set(msg.id, {
      line, sid: typeof sid === 'string' ? sid : undefined,
    });
    return { msg, dest: null };
  }
  const req = pendingClientReqs.get(msg.id) ?? null;
  pendingClientReqs.delete(msg.id);
  if (req) {
    msg.id = req.origId;
    // A `session/new` response names the fresh sessionId — claim it for the
    // socket that asked.
    if (req.method === 'session/new') {
      const sid = msg.result?.sessionId;
      if (typeof sid === 'string') sessionOwner.set(sid, req.ws);
    }
    // A settled prompt releases any session/load queued behind it.
    if (req.method === 'session/prompt' && typeof req.sid === 'string') {
      flushDeferredLoads(req.sid);
    }
  }
  return { msg, dest: req ? req.ws : null, rewritten: !!req };
}

/** Answer every pending client request with a JSON-RPC error so the failure
 * is attributable per-request, not just a bare socket close. Each error goes
 * to the socket that asked, carrying its original request id. */
function failPending(message) {
  for (const [bridged, req] of [...pendingClientReqs]) {
    pendingClientReqs.delete(bridged);
    const ws = req.ws;
    if (!ws || !clients.has(ws) || ws.readyState !== 1) continue;
    try {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: req.origId,
        error: { code: -32000, message },
      }));
    } catch (e) {
      log('send failed:', e.message);
    }
  }
}

const watchdog = setInterval(() => {
  if (pendingClientReqs.size === 0 || pendingAgentReqs.size > 0) return;
  const idleFor = Date.now() - lastTrafficAt;
  if (idleFor < IDLE_TIMEOUT_MS) return;
  const message =
    `no traffic for ${Math.round(idleFor / 1000)}s — agent appears wedged ` +
    `(idle limit ${Math.round(IDLE_TIMEOUT_MS / 1000)}s)`;
  log(`watchdog: ${message}; failing ${pendingClientReqs.size} pending request(s)`);
  failPending(message);
  // The process produced nothing for a whole idle window; it cannot be
  // trusted. Detach this generation before signaling it so the next client
  // message may start a replacement without accepting stale callbacks.
  const stuck = processOwner.current;
  processOwner.stop(stuck, 'SIGKILL');
}, WATCHDOG_TICK_MS);
watchdog.unref?.();

// ---------------------------------------------------------------------------
// WebSocket-protocol liveness sweep
// ---------------------------------------------------------------------------
// A client that vanishes without a FIN (laptop sleep, network drop, dead
// browser tab held open by the OS) leaves a half-open socket: reads block
// forever and ws.send() silently buffers. Every WS_PING_INTERVAL_MS each
// socket must have produced SOME inbound frame (a pong for our protocol
// ping, or any data frame — the ws.on('message') handler renews it too);
// sockets that didn't are terminated, which runs the ordinary 'close'
// cleanup: drop sessionOwner claims and pendingClientReqs entries.
// Detection bound ≈ 2×interval. Browsers cannot send protocol pings, so the
// client side uses the app-level `$/ping`/`$/pong` above; this sweep is the
// server side of the same story and works through https-front's raw TCP
// pipe because protocol pings are just frames.
const WS_PING_INTERVAL_MS = Number(
  argValue('--ws-ping-interval-ms', process.env.ACP_WS_PING_INTERVAL_MS || 30_000)
);
if (WS_PING_INTERVAL_MS > 0) {
  const wsSweep = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      if (ws.isAlive === false) {
        log('ws sweep: terminating unresponsive client');
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, WS_PING_INTERVAL_MS);
  wsSweep.unref?.();
}

/** Deliver one agent frame. A frame that names a claimed sessionId goes to
 * the owning socket only; a response (dest — the socket whose request it
 * answers, known by its bridged id) goes to that socket only; everything
 * else (sessionless frames, sessions nobody claimed, stray responses)
 * keeps the old broadcast-to-everyone behavior. */

/** Send-buffer cap per socket — see broadcast(). */
const WS_BUFFERED_CAP = 32 * 1024 * 1024;

function broadcast(line, msg, dest) {
  const sid = msg?.params?.sessionId;
  const owner =
    (typeof sid === 'string' ? sessionOwner.get(sid) : undefined) ?? dest ?? undefined;
  const targets = owner && clients.has(owner) ? [owner] : clients;
  for (const ws of targets) {
    if (ws.readyState === 1) {
      // Backstop for the sweep window: a socket that stopped draining piles
      // up ws.send() buffers (a replay into a dead tab can run to tens of
      // MB). Past the cap we skip it — the sweep will terminate it shortly.
      if ((ws.bufferedAmount ?? 0) > WS_BUFFERED_CAP) {
        if (!ws.capLogged) {
          ws.capLogged = true;
          log('ws bufferedAmount over cap — dropping frames for undrained client');
        }
        continue;
      }
      try {
        ws.send(line);
      } catch (e) {
        log('send failed:', e.message);
      }
    }
  }
}

function spawnChild() {
  const [bin, ...args] = command.split(/\s+/);
  const child = processOwner.start([bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }, {
    onError: (e, state) => {
      if (!state.current) return;
      log('child error:', e.message);
      failPending(`agent CLI failed to start: ${e.message}`);
      pendingAgentReqs.clear();
      for (const ws of clients) {
        try {
          ws.close(1011, 'child error');
        } catch {
          /* ignore */
        }
      }
    },
    onExit: (code, signal, state) => {
      if (!state.current) return;
      log(`child exited code=${code} signal=${signal}`);
      buffer = '';
      failPending(`agent CLI exited (code=${code} signal=${signal})`);
      pendingAgentReqs.clear();
      for (const ws of clients) {
        try {
          ws.close(1011, `child exited code=${code}`);
        } catch {
          /* ignore */
        }
      }
    },
  });
  log(`spawned ${bin} pid=${child.pid}`);
  buffer = '';
  pendingAgentReqs.clear();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (processOwner.current !== child) return;
    buffer += chunk;
    let idx;
    // Emit only complete NDJSON lines, one per WebSocket frame.
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const inb = noteInbound(line);
        // A routed response carries the caller's original id — re-serialize
        // so the socket sees its own numbering, not the bridged one.
        broadcast(inb?.rewritten ? JSON.stringify(inb.msg) : line,
          inb?.msg ?? null, inb?.dest ?? null);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    if (processOwner.current === child) process.stderr.write(d);
  });

}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server });

server.on('error', (e) => log('server error:', e.message));

wss.on('connection', (ws) => {
  clients.add(ws);
  log(`client connected (${clients.size} active)`);
  // Liveness lease for the sweep: any inbound frame (protocol pong or data)
  // proves the peer alive. `error` always precedes `close`; without a
  // listener it would throw through the EventEmitter contract.
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('error', (e) => log('ws error:', e instanceof Error ? e.message : e));
  if (!processOwner.current) spawnChild();

  ws.on('message', (data) => {
    ws.isAlive = true;
    const payload = data.toString();
    try {
      // Resolve relative working directories against the bridge root so the
      // UI can accept "./projects/foo" as well as absolute paths. Absolute
      // paths pass through untouched (the agent validates them).
      let line = payload.endsWith('\n') ? payload : payload + '\n';
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        /* not JSON — forward verbatim */
      }
      if (
        msg &&
        msg.method === 'session/new' &&
        msg.params &&
        typeof msg.params.cwd === 'string' &&
        msg.params.cwd.trim() !== '' &&
        !path.isAbsolute(msg.params.cwd)
      ) {
        msg.params.cwd = path.resolve(root, msg.params.cwd);
        line = JSON.stringify(msg) + '\n';
        log(`resolved relative cwd -> ${msg.params.cwd}`);
      }
      // noteOutbound rewrites request ids to bridge-unique ones; what goes
      // to the child is its returned payload, not the raw frame. `$/ping`
      // heartbeat lines are answered inline there and dropped — so a
      // heartbeat-only payload produces an empty `out` and must not reach
      // the child (nor respawn it just to keep a NAT mapping warm).
      const out = noteOutbound(line, ws);
      if (out) {
        if (!processOwner.current) spawnChild();
        processOwner.current.stdin.write(out);
      }
    } catch (e) {
      log('stdin write failed:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Drop the socket's session claims and pending requests so its sessions
    // fall back to broadcast instead of routing frames into a dead socket.
    for (const [sid, owner] of sessionOwner) {
      if (owner === ws) sessionOwner.delete(sid);
    }
    for (const [bid, req] of pendingClientReqs) {
      if (req.ws === ws) pendingClientReqs.delete(bid);
    }
    // Queued loads owned by this socket die with it; loads blocked on a prompt
    // this socket abandoned can finally go through.
    for (const [sid, q] of deferredLoads) {
      const kept = q.filter((e) => e.ws !== ws);
      if (kept.length) deferredLoads.set(sid, kept);
      else deferredLoads.delete(sid);
    }
    flushDeferredLoads();
    log(`client closed (${clients.size} active)`);
  });
});

server.listen(port, () => log(`http+ws listening on :${port} -> ${command} (root=${root})`));
