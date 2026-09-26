// acp-state-server.mjs — shared KV state service for the ACP UI panel.
//
// Lets every device on the host (laptop, phone) read/write the same panel
// state (board, projects, sessions, limits, activity, preferences, ...).
// The panel's `src/lib/host/storage.ts` talks to this over HTTP when the
// host answers on port 25900, and silently falls back to `localStorage`
// otherwise.
//
//   STATE_DIR=/tmp/state-test PORT=25909 node server/acp-state-server.mjs
//
// Routes (permissive CORS: `*`, content-type, GET/PUT/DELETE/OPTIONS):
//   GET    /health            -> { ok: true, dir, docs: N }
//   GET    /api/state         -> { docs: [{ name, rev, updatedAt, bytes }] }
//   GET    /api/state/:name   -> { name, rev, updatedAt, data } (404 if missing)
//   PUT    /api/state/:name   body { data, rev? } -> { name, rev, updatedAt }
//                              rev mismatch -> 409 + current { rev, updatedAt }
//                              body > 5 MiB -> 413
//   DELETE /api/state/:name   -> { name, deleted: true } (404 if missing)
//
// Name validation: /^[a-z0-9._-]{1,64}$/ -> 400 otherwise.
// Writes are atomic (temp file + rename); `rev` increments on every PUT.
//
// Node only, zero dependencies.

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const PORT = Number(process.env.PORT || '25900');
const STATE_DIR =
  process.env.STATE_DIR || join(homedir(), '.hermes', 'acp-ui-state');
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const NAME_RE = /^[a-z0-9._-]{1,64}$/;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function docPath(name) {
  // Names are validated against NAME_RE (no slashes, no `..`), and we
  // resolve + prefix-check anyway so a hostile name can never escape dir.
  const p = resolve(STATE_DIR, `${name}.json`);
  if (p !== resolve(STATE_DIR, `${name}.json`) || !p.startsWith(resolve(STATE_DIR) + sep)) {
    return null;
  }
  return p;
}

async function readDoc(name) {
  const p = docPath(name);
  if (!p) return { invalid: true };
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return { doc: JSON.parse(raw) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true };
    throw e;
  }
}

async function listDocs() {
  let files = [];
  try {
    files = await fs.readdir(STATE_DIR);
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    if (!NAME_RE.test(name)) continue;
    try {
      const st = await fs.stat(join(STATE_DIR, f));
      const raw = await fs.readFile(join(STATE_DIR, f), 'utf-8');
      let rev = 0;
      let updatedAt = 0;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.rev === 'number') rev = parsed.rev;
        if (typeof parsed.updatedAt === 'number') updatedAt = parsed.updatedAt;
      } catch {
        // Corrupt file: still list it by size so /health stays honest.
      }
      out.push({ name, rev, updatedAt, bytes: st.size });
    } catch {
      // Raced with a delete — skip.
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        // Keep draining so the socket stays usable, but drop the bytes.
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

const server = createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
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
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/health') {
      const docs = await listDocs();
      send(res, 200, { ok: true, dir: STATE_DIR, docs: docs.length });
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      const docs = await listDocs();
      send(res, 200, { docs });
      return;
    }

    const m = /^\/api\/state\/([^/]+)$/.exec(path);
    if (m && req.method) {
      const name = decodeURIComponent(m[1]);
      if (!NAME_RE.test(name)) {
        send(res, 400, { error: 'invalid name (^[a-z0-9._-]{1,64}$)' });
        return;
      }

      if (req.method === 'GET') {
        const { doc, missing } = await readDoc(name);
        if (missing || !doc) {
          send(res, 404, { error: 'not found' });
          return;
        }
        send(res, 200, {
          name,
          rev: doc.rev,
          updatedAt: doc.updatedAt,
          data: doc.data,
        });
        return;
      }

      if (req.method === 'PUT') {
        let raw;
        try {
          raw = await readBody(req);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            send(res, 413, { error: 'document exceeds 5 MiB' });
            return;
          }
          throw e;
        }
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          send(res, 400, { error: 'invalid JSON body' });
          return;
        }
        if (!body || typeof body !== 'object' || !('data' in body)) {
          send(res, 400, { error: 'body must be { data, rev? }' });
          return;
        }
        if (Buffer.byteLength(JSON.stringify(body.data), 'utf-8') > MAX_BODY_BYTES) {
          send(res, 413, { error: 'document exceeds 5 MiB' });
          return;
        }
        const wantRev =
          body.rev === undefined || body.rev === null ? null : Number(body.rev);
        if (wantRev !== null && !Number.isInteger(wantRev)) {
          send(res, 400, { error: 'rev must be an integer' });
          return;
        }

        const { doc: cur } = await readDoc(name);
        const curRev = cur && typeof cur.rev === 'number' ? cur.rev : 0;
        if (wantRev !== null && cur && wantRev !== curRev) {
          send(res, 409, {
            error: 'rev conflict',
            rev: curRev,
            updatedAt: cur.updatedAt,
          });
          return;
        }
        const next = {
          name,
          rev: curRev + 1,
          updatedAt: Date.now(),
          data: body.data,
        };
        const payload = JSON.stringify(next);
        // Atomic write: temp file NEXT TO the destination (same device, so
        // the rename is legal) + rename. A scratch dir under /tmp breaks
        // with EXDEV once the state dir is a bind mount — different
        // filesystem, rename refuses.
        const dest = docPath(name);
        const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
        try {
          await fs.writeFile(tmp, payload, 'utf-8');
          await fs.rename(tmp, dest);
        } catch (e) {
          await fs.unlink(tmp).catch(() => {});
          throw e;
        }
        send(res, 200, { name, rev: next.rev, updatedAt: next.updatedAt });
        return;
      }

      if (req.method === 'DELETE') {
        const p = docPath(name);
        try {
          await fs.unlink(p);
        } catch (e) {
          if (e && e.code === 'ENOENT') {
            send(res, 404, { error: 'not found' });
            return;
          }
          throw e;
        }
        send(res, 200, { name, deleted: true });
        return;
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('request failed:', e);
    try {
      send(res, 500, { error: 'internal error' });
    } catch {
      // Response already half-sent — nothing left to do.
    }
  }
});

await fs.mkdir(STATE_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`acp-state-server listening on :${PORT} dir=${STATE_DIR}`);
});
