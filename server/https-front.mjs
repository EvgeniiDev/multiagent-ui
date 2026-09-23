// HTTPS terminator for the ACP panel on the LAN.
//
// Why this exists: a browser only exposes `navigator.mediaDevices.getUserMedia`
// in a secure context (https:// or localhost). The whole panel is served over
// http://192.168.1.222:25808, so voice input would be a dead button — the mic is
// simply not available on plain HTTP. Terminating TLS here fixes that for the
// panel AND makes the other LAN services usable from the same origin story.
//
// One cert covers the whole host (CN acp.lan, SAN IP:192.168.1.222 + DNS acp.lan),
// so a single terminator fronts several upstreams by port:
//
//   https://192.168.1.222:25809/  ->  http://127.0.0.1:25808   (the panel)
//   https://192.168.1.222:25906/  ->  http://127.0.0.1:25905   (GigaAM STT)
//
// Everything is reverse-proxied by TARGET map; HTTP and WebSocket upgrades both
// pass through. The self-signed cert means the browser shows a warning once —
// accept it, and voice input works.
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
const TARGETS = {
  25809: 25808,   // the panel itself
  25906: 25905,   // GigaAM STT service (health + ws/stream)
};

const log = (...args) => console.log(new Date().toISOString(), ...args);

function httpProxy(targetPort) {
  return (req, res) => {
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${UPSTREAM_HOST}:${targetPort}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`ACP HTTPS proxy upstream error (${targetPort}): ${error.message}`);
    });
    req.pipe(upstream);
  };
}

function wsProxy(targetPort) {
  // Raw TCP tunnel for upgraded connections and WebSockets: after the request
  // line + headers are forwarded, both sockets are simply piped together.
  return (req, clientSocket, head) => {
    const upstream = net.connect(targetPort, UPSTREAM_HOST, () => {
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        headerLines.push(
          name.toLowerCase() === 'host' ? `${name}: ${UPSTREAM_HOST}:${targetPort}` : `${name}: ${value}`,
        );
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
    httpProxy(Number(upstreamPort)),
  );
  server.on('upgrade', wsProxy(Number(upstreamPort)));
  server.listen(Number(listenPort), '0.0.0.0', () =>
    log(`https ${listenPort} -> http ${upstreamPort}`),
  );
}
