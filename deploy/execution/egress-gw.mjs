#!/usr/bin/env node
// deploy/execution/egress-gw.mjs — the single egress point for worker
// containers (F1).
//
// Workers sit on per-attempt `internal` networks — no external DNS, no
// direct route. The only reachable host is this gateway (attached to each
// worker net under a fixed alias). It implements a minimal locked-down
// forward proxy:
//
//   * CONNECT host:port  — for https model/search/API traffic.
//   * origin-form/absolute-form http requests — for http upstreams
//     (e.g. the registered zen-relay LAN endpoint).
//
// Destination policy is an allowlist built ONLY from the deployment
// config's egress rules: provider hosts must resolve to globally-public
// IPs (every resolved address — a private answer kills the request);
// private/link-local/loopback/multicast/CGNAT/metadata are refused;
// explicitly registered private upstreams (host or literal IP + port) are
// the sole exception. The gateway connects to the IP it validated, so
// DNS answers can't be rebound between check and connect.
//
// Redirects need no special handling: a redirect target is reached only
// through a fresh CONNECT/request that gets validated again.
//
// Every decision is logged as JSON to stderr for evidence capture.

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import {
  loadEnvironmentConfigSync, egressDecision,
} from '../../server/execution/environment/env-config.mjs';

const log = (obj) => {
  try { process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`); } catch { /* ignore */ }
};

const CONNECT_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 8_000;

async function resolveIps(host) {
  try {
    const res = await Promise.race([
      dns.lookup(host, { all: true, verbatim: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('resolve timeout')), RESOLVE_TIMEOUT_MS)),
    ]);
    return (res || []).map((a) => a.address);
  } catch {
    return [];
  }
}

// Shared with the deterministic tests via env-config's egressDecision.
// The gateway resolves and then CONNECTS TO THE VALIDATED IP — the answer
// used for the check is the answer used for the connection.
async function decide(cfg, host, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    return { allow: false, reason: 'bad_port' };
  }
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  let dec = egressDecision(cfg, { host: h, port: p });
  if (!dec.ok) return { allow: false, reason: dec.code, message: dec.message };
  let ip = h;
  if (!dec.addrs) {
    const addrs = await resolveIps(h);
    dec = egressDecision(cfg, { host: h, port: p, resolvedIps: addrs });
    if (!dec.ok) return { allow: false, reason: dec.code, message: dec.message };
    ip = dec.addrs[0];
  } else {
    ip = dec.addrs[0];
  }
  return { allow: true, reason: dec.entry.kind, ip };
}

export function createEgressGateway({ cfg }) {
  const stats = { allow: 0, deny: 0, connect: 0, forward: 0 };

  const refuseSocket = (sock, reason) => {
    stats.deny++;
    log({ ev: 'deny', reason });
    try {
      sock.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n');
    } catch { /* ignore */ }
    sock.destroy();
  };

  const server = http.createServer(async (req, res) => {
    // absolute-form or origin-form http forward requests
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'invalid'}`);
    } catch {
      stats.deny++;
      log({ ev: 'deny', reason: 'bad_url', url: req.url?.slice?.(0, 200) });
      res.writeHead(400); res.end(); return;
    }
    const host = url.hostname;
    const port = url.port ? Number(url.port) : 80;
    const decision = await decide(cfg, host, port);
    if (!decision.allow) {
      stats.deny++;
      log({ ev: 'deny', reason: decision.reason, host, port, method: req.method });
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`egress-gw: denied (${decision.reason})\n`);
      return;
    }
    stats.allow++; stats.forward++;
    log({ ev: 'allow', kind: 'forward', reason: decision.reason, host, port, ip: decision.ip, method: req.method });
    // Hop-by-hop headers stripped; Host preserved so virtual hosts work.
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    headers['host'] = url.host;
    headers['connection'] = 'close';
    const upstream = http.request({
      host: decision.ip, port,
      path: url.pathname + url.search,
      method: req.method, headers,
      timeout: CONNECT_TIMEOUT_MS,
    });
    upstream.on('timeout', () => upstream.destroy(new Error('connect timeout')));
    upstream.on('error', (e) => {
      log({ ev: 'upstream_error', host, port, err: String(e && e.message || e) });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on('response', (ur) => {
      const rh = { ...ur.headers };
      rh['connection'] = 'close';
      res.writeHead(ur.statusCode || 502, rh);
      ur.pipe(res);
    });
    req.pipe(upstream);
  });

  server.on('connect', async (req, clientSock, head) => {
    const m = /^([^:]+):(\d+)$/.exec(req.url || '');
    const host = m?.[1]; const port = m?.[2] ? Number(m[2]) : null;
    if (!host) return refuseSocket(clientSock, 'bad_connect_target');
    const decision = await decide(cfg, host, port);
    if (!decision.allow) {
      stats.deny++;
      log({ ev: 'deny', reason: decision.reason, host, port, kind: 'connect' });
      try {
        clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      } catch { /* ignore */ }
      clientSock.destroy();
      return;
    }
    stats.allow++; stats.connect++;
    log({ ev: 'allow', kind: 'connect', reason: decision.reason, host, port, ip: decision.ip });
    const upstream = net.connect({ host: decision.ip, port, timeout: CONNECT_TIMEOUT_MS });
    const fail = () => { upstream.destroy(); clientSock.destroy(); };
    upstream.on('timeout', fail);
    upstream.on('error', fail);
    clientSock.on('error', () => upstream.destroy());
    upstream.on('connect', () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSock);
      clientSock.pipe(upstream);
    });
    upstream.setTimeout(300_000, () => fail());   // 5min idle ceiling
  });

  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch { /* ignore */ } });

  return { server, stats };
}

async function main() {
  const cfgFile = process.env.ACP_F1_CONFIG || '/run/f1/environment.config.json';
  const cfg = loadEnvironmentConfigSync(cfgFile, { env: process.env, view: 'controller' });
  const port = Number(process.env.ACP_F1_GW_PORT
    || cfg.environment.egressGateway.proxyPort || 3128);
  const { server, stats } = createEgressGateway({ cfg });
  server.listen(port, '0.0.0.0', () => {
    log({ ev: 'listening', port, allowlist: cfg.egress.allowlist.length });
  });
  setInterval(() => log({ ev: 'stats', ...stats }), 60_000).unref();
}

if (process.argv[1] && process.argv[1].endsWith('egress-gw.mjs')) {
  main().catch((e) => { log({ ev: 'fatal', err: String(e && e.stack || e) }); process.exit(2); });
}
