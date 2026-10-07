// acp-state-server.mjs — HTTP adapter for the durable state service.
//
// All request semantics (legacy KV CAS, porch read-only, /api/execution/*)
// live in server/execution/state-service.mjs behind service.request(); this
// file only adapts sockets to it — so importing this module does NOT bind a
// port (main() runs only when executed directly) and tests can exercise the
// real handler with fake req/res objects.
//
// Deployment contract (unchanged):
//   STATE_DIR (default ~/.hermes/acp-ui-state) — compose sets the host path
//     directly; the container runs on host networking and sees it as-is.
//   PORT      (default 25900)
//
//   STATE_DIR=/tmp/state-test PORT=25909 node server/acp-state-server.mjs
//
// Permissive CORS `*` (unchanged); POST added to allowed methods for the
// execution command route. Over-5 MiB bodies -> 413; malformed URL -> 400.

import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createStateService } from './execution/state-service.mjs';
import { nativeUsage } from './usage/native-usage.mjs';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The socket-facing contract — same shape the flat server sent.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export function resolveConfig(env = process.env) {
  const stateDir =
    env.STATE_DIR && env.STATE_DIR.trim()
      ? env.STATE_DIR.trim()
      : join(homedir(), '.hermes', 'acp-ui-state');
  const port = Number(env.PORT || '25900');
  return { stateDir, port };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

// Drains-but-drops past the limit so the socket stays usable; rejects with
// PAYLOAD_TOO_LARGE, which the handler maps to 413.
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        const err = new Error('payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      resolveBody(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

export function createRequestHandler(service, { usageReader = nativeUsage } = {}) {
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      send(res, 400, { error: 'bad request' });
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        send(res, 200, await usageReader());
        return;
      }
      let bodyText;
      if (req.method === 'PUT' || req.method === 'POST') {
        // Declared length over the limit: drain the socket so keep-alive stays
        // usable, then refuse — same 413 as a body that actually streamed past.
        const declared = Number(req.headers?.['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          try {
            for await (const _ of req) {
              /* drain */
            }
          } catch {
            /* socket gone — still answer */
          }
          send(res, 413, { error: 'document exceeds 5 MiB', code: 'too_large' });
          return;
        }
        try {
          bodyText = await readBody(req);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            send(res, 413, { error: 'document exceeds 5 MiB', code: 'too_large' });
            return;
          }
          throw e;
        }
      }
      const { status, json } = await service.request({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        bodyText,
        headers: req.headers,
      });
      send(res, status, json);
    } catch (e) {
      console.error('request failed:', e);
      try {
        send(res, 500, { error: 'internal error', code: 'internal' });
      } catch {
        // Response already half-sent — nothing left to do.
      }
    }
  };
}

async function main() {
  const { stateDir, port } = resolveConfig(process.env);
  const service = await createStateService({ stateDir });
  const server = createServer(createRequestHandler(service));
  server.listen(port, '0.0.0.0', () => {
    console.log(`acp-state-server listening on :${port} dir=${stateDir}`);
  });
}

// Only bind a port when this file is the entry point — importing the module
// (tests, tooling) must never listen.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error('acp-state-server failed:', e);
    process.exit(1);
  });
}
