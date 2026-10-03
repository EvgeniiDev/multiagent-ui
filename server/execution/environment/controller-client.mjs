// server/execution/environment/controller-client.mjs — runner→controller RPC.
//
// The trusted environment controller listens on a unix socket under the
// environment root. Every call carries the channel token in the
// x-acp-internal-token header — the token file is provisioned by the
// controller (0600, uid-shared root), the client only reads it. Same
// pattern as internal-transport.mjs, separate channel and file.
//
// Transport is a minimal HTTP/1.1 POST /rpc {method, params} over the unix
// socket; injectable for tests. Payloads are bounded; error bodies map to
// RuntimeError with the controller's stable code.

import { promises as fs } from 'node:fs';
import http from 'node:http';
import { RuntimeError } from '../common.mjs';
import { TOKEN_RE } from '../internal-transport.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function loadEnvChannelToken(tokenFile) {
  let t;
  try { t = (await fs.readFile(tokenFile, 'utf8')).trim(); }
  catch (e) {
    throw new RuntimeError('env_channel_unprovisioned',
      `env channel token not readable at ${tokenFile}: ${e.code || e.message}`);
  }
  if (!TOKEN_RE.test(t)) {
    throw new RuntimeError('env_channel_unprovisioned',
      `env channel token at ${tokenFile} is malformed`);
  }
  return t;
}

function httpRpc(socketPath, { method, params, token, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ method, params });
    const req = http.request({
      socketPath,
      path: '/rpc',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-acp-internal-token': token,
        'connection': 'close',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0, truncated = false;
      res.on('data', (c) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
        else truncated = true;
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* handled below */ }
        resolve({ status: res.statusCode, parsed, truncated, raw: text.slice(0, 2000) });
      });
      res.on('error', (e) => resolve({ status: 0, error: e.message }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}

export function createControllerClient({
  socketPath,
  tokenFile,
  token = null,
  transport = null,          // test seam: async ({method,params,token}) => {status, parsed}
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = 16 * 1024 * 1024,
} = {}) {
  if (!transport && typeof socketPath !== 'string') {
    throw new RuntimeError('invalid_argument', 'controller client needs socketPath');
  }
  let cached = token;
  async function auth() {
    if (!cached) cached = await loadEnvChannelToken(tokenFile);
    return cached;
  }

  async function call(method, params = {}, { timeoutMs: t } = {}) {
    const tok = await auth();
    const doCall = transport || ((args) => httpRpc(socketPath, args));
    const res = await doCall({ method, params, token: tok, timeoutMs: t ?? timeoutMs, maxBytes });
    if (!res || res.status === 0) {
      throw new RuntimeError('controller_unreachable',
        `controller call ${method} failed: ${res?.error || 'no response'}`);
    }
    if (res.truncated) {
      throw new RuntimeError('controller_response_truncated',
        `controller call ${method} response exceeded ${maxBytes} bytes`);
    }
    const b = res.parsed;
    if (!b || typeof b !== 'object') {
      throw new RuntimeError('controller_bad_response',
        `controller call ${method} -> ${res.status}: non-JSON body`);
    }
    if (res.status !== 200 || b.ok !== true) {
      const code = typeof b?.error?.code === 'string' ? b.error.code : 'controller_error';
      const err = new RuntimeError(code,
        b?.error?.message || `controller call ${method} -> ${res.status}`);
      err.status = res.status;
      if (b?.error && typeof b.error === 'object') {
        err.details = Object.fromEntries(
          Object.entries(b.error).filter(([k]) => !['code', 'message'].includes(k)));
      }
      throw err;
    }
    return b.result;
  }

  return {
    call,
    ping: () => call('ping'),
    workerPrepare: (spec, o) => call('worker.prepare', spec, o),
    workerStatus: (workerId) => call('worker.status', { workerId }),
    workerList: () => call('worker.list'),
    workerStop: (workerId, o = {}) => call('worker.stop', { workerId, ...o }),
    workerRemove: (workerId) => call('worker.remove', { workerId }),
    exec: (spec, o) => call('worker.exec', spec, o),
    canonicalPrepare: (spec) => call('canonical.prepare', spec),
    canonicalStatus: (canonicalId) => call('canonical.status', { canonicalId }),
    repoImport: (workerId) => call('repo.import', { workerId }),
    depsPrepare: (spec, o) => call('deps.prepare', spec, o),
    depsStatus: (depSetId) => call('deps.status', { depSetId }),
    depsCheck: (depSetId, o) => call('deps.check', { depSetId }, o),
    registrySnapshot: () => call('registry.snapshot'),
  };
}
