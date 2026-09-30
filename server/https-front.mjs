// HTTPS terminator for the ACP panel on the LAN.
//
// Why this exists: a browser only exposes `navigator.mediaDevices.getUserMedia`
// in a secure context (https:// or localhost), and — just as important — it
// BLOCKS mixed content: a page served over https cannot fetch http:// or
// connect to ws://. So the TERMINATOR is the only entry point; the plain-HTTP
// services stay on loopback and are reachable from the LAN solely through TLS
// here.
//
// One cert covers the whole host (CN acp.lan, SAN IP:192.168.1.222 + DNS acp.lan),
// so a single process fronts every upstream by port:
//
//   https 25809 -> http 127.0.0.1:25808   the panel bundle
//   https 25906 -> http 127.0.0.1:25905   GigaAM STT (health + /ws/stream)
//   https 25910 -> http 127.0.0.1:25900   shared state server (board/claims/roles)
//   https 25911 -> http 127.0.0.1:25901   ACP bridge: Hermes Agent
//   https 25912 -> http 127.0.0.1:25902   ACP bridge: OpenCode
//   https 25913 -> http 127.0.0.1:25903   ACP bridge: Devin
//   https 25914 -> http 127.0.0.1:25904   ACP bridge: Pi
//
// The +10 offset for the state server and the bridges is the convention the
// panel reads too (`src/lib/host/secure.ts`): insecure port + 10 = secure port.
// STT (25905 -> 25906) and the panel (25808 -> 25809) predate that convention
// and keep their +1 ports, which the panel also knows.
//
// CORS: the panel is one origin (https://host:25809) and every other service is
// a different port, i.e. a different origin. Cross-origin fetches (the STT
// health probe, POST /api/fs/write with a JSON body) need CORS headers and a
// preflight answer, so this proxy adds `Access-Control-Allow-Origin: *` to
// every proxied response and answers OPTIONS itself. WebSockets are not
// CORS-gated and pass through raw.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

const CERT_DIR = process.env.ACP_TLS_DIR || `${process.env.HOME}/.hermes/acp-tls`;
const CERT = path.join(CERT_DIR, 'acp.crt');
const KEY = path.join(CERT_DIR, 'acp.key');
const UPSTREAM_HOST = '127.0.0.1';

// listen port -> upstream port
//
// `ACP_FRONT_TARGETS` overrides the map as JSON (`{"<listen>": <upstream>}`) so
// an e2e can run THIS proxy on its own ports against stub upstreams — the
// suites then exercise the real terminator, not a re-implementation of it.
const DEFAULT_TARGETS = {
  25809: 25808,   // the panel itself
  25906: 25905,   // GigaAM STT service (health + ws/stream)
  25910: 25900,   // shared state server (board/claims/roles/sessions/activity)
  25911: 25901,   // ACP bridge: Hermes Agent
  25912: 25902,   // ACP bridge: OpenCode
  25913: 25903,   // ACP bridge: Devin
  25914: 25904,   // ACP bridge: Pi
  25915: 6080,    // noVNC — live Camoufox screen (ephemeral, for interactive logins)
};

const TARGETS = process.env.ACP_FRONT_TARGETS
  ? JSON.parse(process.env.ACP_FRONT_TARGETS)
  : DEFAULT_TARGETS;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Permissive CORS: no cookies or credentials are used anywhere in this panel,
// so a wildcard origin costs nothing and lets every port be fetched from the
// panel origin.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

function withCors(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    // Drop the upstream's own CORS wording so the wildcard stays authoritative
    // (a duplicated `Access-Control-Allow-Origin` makes the browser reject it).
    if (name.toLowerCase().startsWith('access-control-')) continue;
    out[name] = value;
  }
  return { ...out, ...CORS_HEADERS };
}

// Per-target header overrides: forwarded proto/host so upstreams behind TLS
// see the real client-facing origin (Express trust-proxy picks it up).
// Format: { <listenPort>: { host, proto } }. host=null keeps rewriting off.
const TARGET_HEADERS = process.env.ACP_FRONT_HEADERS
  ? JSON.parse(process.env.ACP_FRONT_HEADERS)
  : {};

function httpProxy(targetPort, listenPort) {
  return (req, res) => {
    // Preflight is answered here: the upstreams are plain services that know
    // nothing about CORS, and forwarding OPTIONS would 404/405 the browser.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, withCors());
      res.end();
      return;
    }
    const override = TARGET_HEADERS[listenPort];
    // Default: preserve the client-facing Host so upstreams that build
    // absolute URLs/hints (paseo injectConnectionHint) see the real origin.
    // Opt out per-target with {"<port>": {"host": "..."}} or rewriteHost.
    // Preserve the client-facing Host by default (upstreams building
    // absolute URLs/hints see the real origin). Rewrite to loopback only
    // when the target explicitly asks (rewriteHost) or gives no host key.
    const headers = { ...req.headers };
    if (override?.host && override.rewriteHost) {
      headers.host = override.host;
    } else if (!override?.host && !('host' in headers)) {
      headers.host = `${UPSTREAM_HOST}:${targetPort}`;
    }
    if (override) {
      // X-Forwarded-Proto/Host: Express req.protocol + req.headers.host
      // follow them when trust proxy allows. Always send proto; send host
      // from the original request when no explicit host override is given.
      if (override.proto) headers['x-forwarded-proto'] = override.proto;
      const fwdHost = override.host || req.headers.host;
      if (fwdHost) headers['x-forwarded-host'] = fwdHost;
    }
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, withCors(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, withCors({ 'content-type': 'text/plain; charset=utf-8' }));
      }
      res.end(`ACP HTTPS proxy upstream error (${targetPort}): ${error.message}`);
    });
    req.pipe(upstream);
  };
}

function wsProxy(targetPort, listenPort) {
  // Raw TCP tunnel for upgraded connections and WebSockets: after the request
  // line + headers are forwarded, both sockets are simply piped together.
  // Host is preserved from the client (upstreams doing same-origin checks
  // need the real origin host); X-Forwarded-Proto/Host added per target.
  return (req, clientSocket, head) => {
    const upstream = net.connect(targetPort, UPSTREAM_HOST, () => {
      const override = TARGET_HEADERS[listenPort];
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
      let sawForwardedProto = false;
      let sawForwardedHost = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lname = name.toLowerCase();
        if (lname === 'host' && override?.host && override.rewriteHost) {
          headerLines.push(`${name}: ${override.host}`);
          continue;
        }
        if (lname === 'x-forwarded-proto') sawForwardedProto = true;
        if (lname === 'x-forwarded-host') sawForwardedHost = true;
        headerLines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      if (override?.proto && !sawForwardedProto) {
        headerLines.push(`X-Forwarded-Proto: ${override.proto}`);
      }
      const fwdHost = override?.host || (!override ? null : req.headers.host);
      if (override && fwdHost && !sawForwardedHost) {
        headerLines.push(`X-Forwarded-Host: ${fwdHost}`);
      }
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', (error) => {
      log(`ws upstream error (${targetPort}):`, error.message);
      clientSocket.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
  };
}

if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) {
  console.error(`missing cert: ${CERT} / ${KEY} — see the unit's ExecStartPre (openssl)`);
  process.exit(1);
}

for (const [listenPort, upstreamPort] of Object.entries(TARGETS)) {
  const server = https.createServer(
    { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) },
    httpProxy(Number(upstreamPort), listenPort),
  );
  server.on('upgrade', wsProxy(Number(upstreamPort), listenPort));
  server.listen(Number(listenPort), '0.0.0.0', () =>
    log(`https ${listenPort} -> http ${upstreamPort}`),
  );
}
