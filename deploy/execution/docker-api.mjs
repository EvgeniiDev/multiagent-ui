// deploy/execution/docker-api.mjs — minimal Docker Engine API client.
//
// Speaks HTTP/1.1 over /var/run/docker.sock. Only the env-controller uses
// this; the socket never leaves the controller container. Import-safe —
// no IO until a method is called.

import http from 'node:http';

// Negotiated once at first use: the daemon declares its API level via the
// unversioned /version endpoint; we pin calls to min(daemon, 1.49) so a newer
// daemon never sees a too-old client version.
let apiVersionPromise = null;
const MIN_API = '1.44', MAX_API = '1.49';

export function createDockerApi({ socketPath = '/var/run/docker.sock', timeoutMs = 30_000 } = {}) {

  function negotiateVersion() {
    if (apiVersionPromise) return apiVersionPromise;
    apiVersionPromise = new Promise((resolve) => {
      const req = http.request({ socketPath, path: '/version', method: 'GET', timeout: 10_000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let v = null;
          try { v = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.ApiVersion; } catch { /* ignore */ }
          const num = (s) => Number(s?.split('.').map((x, i) => x.padStart(3, '0')).join('') || 0);
          const picked = v && num(v) >= num(MIN_API)
            ? (num(v) > num(MAX_API) ? MAX_API : v)
            : MAX_API;
          resolve(`v${picked}`);
        });
        res.on('error', () => resolve(`v${MAX_API}`));
      });
      req.on('timeout', () => { req.destroy(); resolve(`v${MAX_API}`); });
      req.on('error', () => resolve(`v${MAX_API}`));
      req.end();
    });
    return apiVersionPromise;
  }

  async function request(method, p, { body, timeoutMs: t = timeoutMs, maxBytes = 4 * 1024 * 1024 } = {}) {
    const apiVersion = await negotiateVersion();
    return new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        socketPath,
        path: `/${apiVersion}${p}`,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          'connection': 'close',
        },
        timeout: t,
      }, (res) => {
        const chunks = [];
        let size = 0, truncated = false;
        res.on('data', (c) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c); else truncated = true;
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* text body */ }
          resolve({ status: res.statusCode, parsed, text, truncated });
        });
        res.on('error', (e) => resolve({ status: 0, error: e.message }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.end(payload);
    });
  }

  function apiErr(op, res) {
    const msg = res?.parsed?.message || res?.text?.slice(0, 400) || res?.error || `HTTP ${res?.status}`;
    const err = new Error(`docker ${op} failed (${res?.status}): ${msg}`);
    err.code = 'docker_api';
    err.status = res?.status;
    return err;
  }

  // Hijacked exec stream: POST /exec/{id}/start with Connection/Upgrade:
  // tcp returns a raw multiplexed stream — 8-byte header
  // [stream,0,0,0, BE uint32 size] then payload; stream 1=stdout 2=stderr.
  // Bounded capture with a wall-clock deadline; on timeout the socket is
  // destroyed (the exec'd process is untouched — honest timeout, no kill).
  async function execStart(execId, { timeoutMs, maxStdout, maxStderr, stdin }) {
    const apiVersion = await negotiateVersion();
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const req = http.request({
        socketPath,
        path: `/${apiVersion}/exec/${encodeURIComponent(execId)}/start`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connection': 'upgrade',
          'upgrade': 'tcp',
        },
        timeout: timeoutMs + 5_000,
      });
      let sock = null;
      let out = Buffer.alloc(0), err = Buffer.alloc(0);
      let outTrunc = false, errTrunc = false;
      let timedOut = false, done = false;
      let headerBuf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        timedOut = true;
        try { sock?.destroy(); } catch { /* already gone */ }
      }, timeoutMs);
      timer.unref?.();

      const append = (buf, chunk, max, wasTrunc) => {
        if (wasTrunc) return [buf, true];
        const next = Buffer.concat([buf, chunk]);
        return next.length <= max ? [next, false] : [next.subarray(0, max), true];
      };

      const finish = (extra = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock?.destroy(); } catch { /* ignore */ }
        resolve({
          ok: true, timedOut,
          stdout: out.toString('utf8'), stderr: err.toString('utf8'),
          stdoutTruncated: outTrunc, stderrTruncated: errTrunc,
          durationMs: Date.now() - startedAt, ...extra,
        });
      };

      req.on('upgrade', (res, socket, head) => {
        sock = socket;
        if (res.statusCode !== 101 && res.statusCode !== 200) {
          return finish({ apiError: `exec start -> ${res.statusCode}` });
        }
        // AttachStdin is never enabled — no stdin channel exists to close.
        const onData = (chunk) => {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          for (;;) {
            if (headerBuf.length < 8) return;
            const stream = headerBuf[0];
            const size = headerBuf.readUInt32BE(4);
            if (headerBuf.length < 8 + size) return;
            const payload = headerBuf.subarray(8, 8 + size);
            headerBuf = headerBuf.subarray(8 + size);
            if (stream === 1) [out, outTrunc] = append(out, payload, maxStdout, outTrunc);
            else if (stream === 2) [err, errTrunc] = append(err, payload, maxStderr, errTrunc);
          }
        };
        if (head && head.length) onData(head);
        sock.on('data', onData);
        sock.on('end', () => finish());
        sock.on('error', () => finish({ socketError: true }));
      });
      req.on('response', (res) => {
        // Non-upgraded response = API error body.
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish({
          apiError: `exec start -> ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 400)}`,
        }));
      });
      req.on('timeout', () => { timedOut = true; req.destroy(); });
      req.on('error', (e) => finish({ apiError: e.message }));
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    });
  }

  return {
    raw: request,
    ping: () => new Promise((resolve) => {
      // _ping is intentionally unversioned.
      const req = http.request({ socketPath, path: '/_ping', method: 'GET',
        timeout: 5000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(res.statusCode === 200
          && /OK/.test(Buffer.concat(chunks).toString('utf8'))));
        res.on('error', () => resolve(false));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
      req.end();
    }),
    version: () => request('GET', '/version'),
    info: () => request('GET', '/info'),
    imageInspect: async (ref) => {
      const r = await request('GET', `/images/${encodeURIComponent(ref)}/json`);
      if (r.status !== 200 || !r.parsed) throw apiErr('image inspect', r);
      return r.parsed;
    },
    containerCreate: async (spec) => {
      // Container NAME is a query param — the body's name field is ignored.
      const name = spec.name;
      const body = { ...spec };
      delete body.name;
      const q = name ? `?name=${encodeURIComponent(name)}` : '';
      const r = await request('POST', `/containers/create${q}`, { body, timeoutMs: 60_000 });
      if (r.status !== 201 || !r.parsed?.Id) throw apiErr('container create', r);
      return r.parsed;
    },
    containerStart: async (id) => {
      const r = await request('POST', `/containers/${encodeURIComponent(id)}/start`);
      if (r.status !== 204 && r.status !== 304) throw apiErr('container start', r);
      return true;
    },
    containerPause: async (id) => {
      const r = await request('POST', `/containers/${encodeURIComponent(id)}/pause`);
      if (r.status !== 204) throw apiErr('container pause', r);
      return true;
    },
    containerUnpause: async (id) => {
      const r = await request('POST', `/containers/${encodeURIComponent(id)}/unpause`);
      if (r.status !== 204) throw apiErr('container unpause', r);
      return true;
    },
    containerStop: async (id, { timeoutS = 5 } = {}) => {
      const r = await request('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutS}`);
      if (r.status !== 204 && r.status !== 304) throw apiErr('container stop', r);
      return true;
    },
    containerRemove: async (id, { force = true, volumes = true } = {}) => {
      const r = await request('DELETE',
        `/containers/${encodeURIComponent(id)}?force=${force}&v=${volumes}`);
      if (r.status !== 204 && r.status !== 404) throw apiErr('container remove', r);
      return true;
    },
    containerInspect: async (id) => {
      const r = await request('GET', `/containers/${encodeURIComponent(id)}/json`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.parsed) throw apiErr('container inspect', r);
      return r.parsed;
    },
    containerList: async (filters) => {
      const q = filters ? `?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}` : '?all=1';
      const r = await request('GET', `/containers/json${q}`);
      if (r.status !== 200 || !Array.isArray(r.parsed)) throw apiErr('container list', r);
      return r.parsed;
    },
    execCreate: async (containerId, spec) => {
      const r = await request('POST',
        `/containers/${encodeURIComponent(containerId)}/exec`, { body: spec });
      if (r.status !== 201 || !r.parsed?.Id) throw apiErr('exec create', r);
      return r.parsed.Id;
    },
    execStart,
    execInspect: async (execId) => {
      const r = await request('GET', `/exec/${encodeURIComponent(execId)}/json`);
      if (r.status !== 200 || !r.parsed) throw apiErr('exec inspect', r);
      return r.parsed;
    },
    networkCreate: async (spec) => {
      const r = await request('POST', '/networks/create', { body: spec });
      if (r.status === 201 || r.status === 200) return r.parsed;
      if (r.status === 403 || r.status === 409 || /exists/.test(r.text || '')) {
        return null; // already exists — caller re-inspects
      }
      throw apiErr('network create', r);
    },
    networkInspect: async (name) => {
      const r = await request('GET', `/networks/${encodeURIComponent(name)}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.parsed) throw apiErr('network inspect', r);
      return r.parsed;
    },
    networkConnect: async (netId, containerId, aliases = []) => {
      const r = await request('POST', `/networks/${encodeURIComponent(netId)}/connect`, {
        body: { Container: containerId, EndpointConfig: { Aliases: aliases } },
      });
      if (r.status !== 200 && r.status !== 201) {
        // 'already exists' is idempotent success for our use.
        if (/already exists/i.test(r.text || '')) return true;
        throw apiErr('network connect', r);
      }
      return true;
    },
    networkDisconnect: async (netId, containerId) => {
      const r = await request('POST', `/networks/${encodeURIComponent(netId)}/disconnect`, {
        body: { Container: containerId, Force: true },
      });
      return r.status === 200 || r.status === 201 || r.status === 404;
    },
    networkRemove: async (netId) => {
      const r = await request('DELETE', `/networks/${encodeURIComponent(netId)}`);
      return r.status === 204 || r.status === 404;
    },
  };
}
