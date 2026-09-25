// Stub upstreams for scripts/e2e_https_panel.py — the "agents" behind the
// TLS front under test. Zero dependencies; both servers share this process.
//
//   BRIDGE_PORT (HTTP+WS): GET /api/fs/root|list|mkdir answer like a real
//     bridge; a WebSocket upgrade on any path completes the handshake and
//     speaks just enough ACP JSON-RPC (initialize / session/load /
//     session/list / session/prompt) for the panel to reach isConnected.
//   STT_PORT (HTTP): GET /health -> {ok, model, loaded, sample_rate}.
//
// Every ws upgrade and every HTTP request appends one line to MARKER_FILE
// so the suite can assert the bytes really arrived here through the proxy:
//     "UPGRADE /"                      (ws handshake path)
//     "HTTP GET /api/fs/root"          (plain fetch)
//
//   MARKER_FILE=… BRIDGE_PORT=… STT_PORT=… node scripts/https_panel_stubs.mjs

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 0);
const STT_PORT = Number(process.env.STT_PORT || 0);
const MARKER_FILE = process.env.MARKER_FILE || '';

function mark(line) {
  if (MARKER_FILE) fs.appendFileSync(MARKER_FILE, line + '\n');
  console.log(line);
}

// ---------------------------------------------------------------------------
// Minimal RFC6455: read masked client frames, write unmasked text frames.
// ---------------------------------------------------------------------------

function sendText(sock, str) {
  const payload = Buffer.from(str, 'utf-8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  sock.write(Buffer.concat([header, payload]));
}

function sendPong(sock, payload) {
  const len = payload.length;
  const header = Buffer.from([0x8a, len]);
  sock.write(Buffer.concat([header, payload]));
}

// Stateful per-socket decoder. Calls `onText(str)` for each complete message.
function attachWsReader(sock, onText) {
  let buf = Buffer.alloc(0);
  let frags = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) { sock.end(); return; }          // close
      if (opcode === 0x9) { sendPong(sock, payload); continue; } // ping->pong
      if (opcode === 0x2 || opcode === 0x1 || opcode === 0x0) {
        frags.push(payload);
        if (fin) {
          onText(Buffer.concat(frags).toString('utf-8'));
          frags = [];
        }
      }
    }
  });
  sock.on('error', () => {});
}

// ---------------------------------------------------------------------------
// ACP answers — mirrors the playwright-side mock in e2e_session_restore.py.
// ---------------------------------------------------------------------------

function acpResult(req) {
  const method = req.method;
  if (method === 'initialize') {
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: [],
      agentInfo: { name: 'e2e-https-stub', version: '0' },
    };
  }
  if (method === 'session/new') return { sessionId: 'e2e-https-session' };
  if (method === 'session/list') {
    return {
      sessions: [{
        sessionId: 'e2e-https-session', title: 'https restore',
        cwd: '/home/hermes', updatedAt: new Date().toISOString(),
      }],
    };
  }
  if (method === 'session/prompt') return { stopReason: 'end_turn' };
  return {};
}

function handleUpgrade(req, sock) {
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '');
  const proto = offered.split(',').map((s) => s.trim()).includes('acp.v1')
    ? 'Sec-WebSocket-Protocol: acp.v1\r\n' : '';
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`,
  );
  mark(`UPGRADE ${req.url}`);
  attachWsReader(sock, (text) => {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      if (msg.method === 'session/load' && msg.id !== undefined) {
        const sid = msg.params?.sessionId ?? 'e2e-https-session';
        const upd = (kind, content) => JSON.stringify({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: sid, update: { sessionUpdate: kind, content } },
        });
        sendText(sock, upd('user_message_chunk', { type: 'text', text: 'earlier question' }));
        sendText(sock, upd('agent_message_chunk', { type: 'text', text: 'HTTPS-TRANSCRIPT-MARKER' }));
        sendText(sock, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        continue;
      }
      if (msg.id === undefined) continue; // notification (e.g. $/ping)
      sendText(sock, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: acpResult(msg) }));
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP sides
// ---------------------------------------------------------------------------

const bridge = http.createServer((req, res) => {
  mark(`HTTP ${req.method} ${req.url}`);
  const url = new URL(req.url || '/', 'http://localhost');
  const json = (obj, status = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
  if (url.pathname === '/api/fs/root') return json({ root: '/home/hermes', home: '/home/hermes' });
  if (url.pathname === '/api/fs/list') {
    return json({
      path: '/home/hermes', parent: '/home', root: '/home/hermes',
      dirs: [{ name: 'projects', path: '/home/hermes/projects' }],
    });
  }
  if (url.pathname === '/api/fs/mkdir') {
    return json({ path: '/home/hermes/projects', created: true });
  }
  return json({ error: 'not found' }, 404);
});
bridge.on('upgrade', (req, sock) => {
  if (String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
    handleUpgrade(req, sock);
  } else {
    sock.destroy();
  }
});

const stt = http.createServer((req, res) => {
  mark(`STT ${req.method} ${req.url}`);
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: 'e2e-stub', loaded: true, sample_rate: 16000 }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

bridge.listen(BRIDGE_PORT, '127.0.0.1', () => console.log(`stub bridge on :${BRIDGE_PORT}`));
stt.listen(STT_PORT, '127.0.0.1', () => console.log(`stub stt on :${STT_PORT}`));
