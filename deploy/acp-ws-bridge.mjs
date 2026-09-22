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
// Usage: node acp-ws-bridge.mjs --port 25901 --cmd "hermes acp" [--root /home/x]
import { spawn } from 'node:child_process';
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

if (!Number.isInteger(port) || port <= 0 || !command) {
  console.error('usage: acp-ws-bridge.mjs --port <port> --cmd "<command>" [--root <dir>]');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// HTTP filesystem API (for the acp-ui tree picker)
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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

  json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// WebSocket -> child stdin/stdout plumbing
// ---------------------------------------------------------------------------

const clients = new Set();
let child = null;
let buffer = '';

function broadcast(line) {
  for (const ws of clients) {
    if (ws.readyState === 1) {
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
  child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  log(`spawned ${bin} pid=${child.pid}`);
  buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    // Emit only complete NDJSON lines, one per WebSocket frame.
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) broadcast(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => process.stderr.write(d));

  child.on('error', (e) => {
    log('child error:', e.message);
    child = null;
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  });

  child.on('exit', (code, signal) => {
    log(`child exited code=${code} signal=${signal}`);
    child = null;
    buffer = '';
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  });
}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server });

server.on('error', (e) => log('server error:', e.message));

wss.on('connection', (ws) => {
  clients.add(ws);
  log(`client connected (${clients.size} active)`);
  if (!child) spawnChild();

  ws.on('message', (data) => {
    if (!child) spawnChild();
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
      child.stdin.write(line);
    } catch (e) {
      log('stdin write failed:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log(`client closed (${clients.size} active)`);
  });
});

server.listen(port, () => log(`http+ws listening on :${port} -> ${command} (root=${root})`));
