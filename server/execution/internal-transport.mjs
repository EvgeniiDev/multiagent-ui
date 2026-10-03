// server/execution/internal-transport.mjs — authenticated internal channel.
//
// Runner-side commands (begin_attempt, bind_attempt, heartbeat, workspace
// lifecycle, run events) are NOT the user API. This module implements the
// concrete transport:
//
//   * a token file under <stateDir>/execution/internal-token, mode 0600,
//     owned by the runner uid so the runner can read it over the shared
//     ~/.hermes mount while staying unreadable to everyone else;
//   * POST /api/internal/cards/:id/commands gated on header
//     `x-acp-internal-token` with a timing-safe comparison;
//   * the internal channel is selected BY THE ROUTE + TOKEN, never by a
//     request-body flag — a user request cannot spoof {channel:'internal'}.
//
// Ownership/traversal: the state service may run as a different uid than the
// runner (compose: state=root, runner=1001:1001). A 0600 token owned by the
// writer alone is unreadable by the runner, and a root-owned 0700
// execution/ dir cannot even be traversed. Provisioning is therefore
// explicit and fail-closed:
//   * ACP_EXEC_TOKEN_UID/GID (state service env) name the reader uid/gid;
//   * the token file is chown'd to that uid and kept 0600 — always;
//   * the token dir chain (stateDir, stateDir/execution) is chgrp'd to the
//     reader gid and given group-execute ONLY when the reader cannot already
//     traverse (no private bits are loosened; group never gains read);
//   * every step is verified by re-stat; any failure (chown denied, chmod
//     failed, symlink in the path, foreign-owned files we cannot reconcile)
//     reports unprovisioned — the route stays disabled with a diagnostic.
//
// The token value itself never enters env vars, run/attempt records, run
// events, KV documents, error payloads, or logs. Provisioning results carry
// it only inside the local auth closure (`token` field is consumed by the
// service's private gate, never serialized to any endpoint or status doc).

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { RuntimeError } from './common.mjs';

const TOKEN_BYTES = 24;             // 48 hex chars
export const TOKEN_RE = /^[0-9a-f]{48}$/;
export const INTERNAL_TOKEN_HEADER = 'x-acp-internal-token';
const TOKEN_MODE = 0o600;

export function tokenFilePath(stateDir) {
  return path.join(stateDir, 'execution', 'internal-token');
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function readToken(tokenFile) {
  try {
    const t = (await fs.readFile(tokenFile, 'utf8')).trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

// Can (uid,gid) traverse `dir`? Checks the actual mode bits — owner-exec,
// group-exec for the reader gid, or world-exec. Returns true/false/null
// (unverifiable when stat fails).
async function traversableBy(dir, readerUid, readerGid) {
  const st = await fs.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return null;
  const mode = st.mode & 0o777;
  if (st.uid === readerUid) return (mode & 0o100) !== 0;
  if (st.gid === readerGid) return (mode & 0o010) !== 0;
  return (mode & 0o001) !== 0;
}

// Give the reader gid traversal on `dir` without loosening anything: chgrp
// to the reader gid, then ADD the group-execute bit. Owner/other bits are
// preserved exactly. Failures propagate — a half-provisioned dir must never
// report success.
async function provisionTraversal(dir, readerUid, readerGid) {
  const cur = await traversableBy(dir, readerUid, readerGid);
  if (cur === null) {
    throw new RuntimeError('token_traversal_unverifiable',
      `cannot stat ${dir} for traversal check`);
  }
  if (cur === true) return false; // already traversable — leave untouched
  const st = await fs.stat(dir);
  await fs.chown(dir, st.uid, readerGid);
  const nextMode = (st.mode & 0o7777) | 0o010;
  await fs.chmod(dir, nextMode);
  const after = await traversableBy(dir, readerUid, readerGid);
  if (after !== true) {
    throw new RuntimeError('token_traversal_unprovisioned',
      `reader gid ${readerGid} still cannot traverse ${dir}`);
  }
  return true;
}

// Provision-or-load the internal token.
//
// Returns:
//   { ok: true,  tokenFile, token }              — usable now
//   { ok: false, tokenFile, code, message }      — fail-closed diagnostic
//   `token` is present only for the caller's private auth closure; it is
//   stripped before any status/log/event surface (see service usage).
//
// readerUid/readerGid default to ACP_EXEC_TOKEN_UID/GID. When unset the
// transport cannot prove the runner can read the file: the token is still
// created for in-process/same-uid use, but the result is unprovisioned so
// the HTTP route refuses with a diagnostic.
export async function ensureInternalToken(stateDir, {
  readerUid = numOrNull(process.env.ACP_EXEC_TOKEN_UID),
  readerGid = numOrNull(process.env.ACP_EXEC_TOKEN_GID),
} = {}) {
  const tokenFile = tokenFilePath(stateDir);
  const tokenDir = path.dirname(tokenFile);
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const fail = (code, message) => ({ ok: false, tokenFile, code, message });
  const configured = readerUid !== null && readerGid !== null;

  // mkdir recursive does not throw on an existing dir — any failure here is
  // a real provisioning fault (EACCES/ENOTDIR/EROFS), not "already there".
  try {
    await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return fail('token_dir_unwritable',
      `cannot create internal-token dir ${tokenDir}: ${e.code || e.message}`);
  }

  // lstat: a symlink or non-regular file at the token path is refused —
  // following it would read/write somewhere unverifiable. ENOENT is absence;
  // EACCES/EPERM/other errors are diagnostics, never "not there".
  let lst = null;
  try {
    lst = await fs.lstat(tokenFile);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return fail('token_stat_failed',
        `cannot lstat internal-token path ${tokenFile}: ${e.code || e.message}`);
    }
  }
  if (lst && !lst.isFile()) {
    return fail('token_not_file', 'internal-token path exists and is not a regular file');
  }

  let token;
  if (!lst) {
    token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    try {
      await fs.writeFile(tokenFile, token, { mode: TOKEN_MODE, flag: 'wx' });
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        return ensureInternalToken(stateDir, { readerUid, readerGid });
      }
      return fail('token_write_failed', e.message);
    }
  } else {
    // Tighten to exactly 0600; chmod failure is not swallowable — a token
    // left world-readable would be a live leak we knowingly ignored.
    if ((lst.mode & 0o777) !== TOKEN_MODE) {
      try {
        await fs.chmod(tokenFile, TOKEN_MODE);
      } catch (e) {
        return fail('token_mode_unfixable',
          `cannot tighten internal-token mode to 0600: ${e.message}`);
      }
    }
    token = await readToken(tokenFile);
    if (!token) {
      return fail('token_unreadable', 'internal-token exists but cannot be read');
    }
  }

  // Ownership reconcile: the configured reader must own the file (0600 means
  // only the owner can read). A foreign owner we cannot chown fails closed.
  if (configured) {
    const st = await fs.stat(tokenFile).catch(() => null);
    if (!st) return fail('token_unreadable', 'internal-token stat failed after provisioning');
    if (st.uid !== readerUid || st.gid !== readerGid) {
      try {
        await fs.chown(tokenFile, readerUid, readerGid);
      } catch (e) {
        return fail('token_reader_unprovisioned',
          `cannot chown internal-token to ${readerUid}:${readerGid} (owned by ${st.uid}:${st.gid}): ${e.message}`);
      }
    }
    // Verify: re-stat after every mutation path.
    const st2 = await fs.stat(tokenFile).catch(() => null);
    if (!st2 || st2.uid !== readerUid || st2.gid !== readerGid
      || (st2.mode & 0o777) !== TOKEN_MODE) {
      return fail('token_reader_unprovisioned',
        'internal-token ownership/mode did not verify after provisioning');
    }
    // Directory traversal: the reader must be able to reach the file —
    // stateDir AND the token dir are provisioned (chgrp + group-exec only).
    for (const dir of [stateDir, tokenDir]) {
      try {
        await provisionTraversal(dir, readerUid, readerGid);
      } catch (e) {
        return fail(e.code || 'token_traversal_unprovisioned', e.message);
      }
    }
    return { ok: true, tokenFile, token };
  }

  // No configured reader: usable in-process / same-uid only. Self-owned is
  // reported unprovisioned (runner readability unproven); foreign-owned is a
  // hard failure (belongs to a deployment we cannot reason about).
  const st = await fs.stat(tokenFile).catch(() => null);
  if (st && st.uid !== selfUid) {
    return fail('token_reader_unprovisioned',
      `internal-token owned by uid ${st.uid}, not us (${selfUid}); reader unconfigured`);
  }
  return { ok: false, tokenFile, token, code: 'token_reader_unconfigured',
    message: 'ACP_EXEC_TOKEN_UID/GID unset: reader ownership cannot be proven; internal HTTP transport unprovisioned' };
}

// Runner-side: read the token file we were provisioned to read.
export async function loadInternalToken(stateDir) {
  const tokenFile = tokenFilePath(stateDir);
  const token = await readToken(tokenFile);
  if (!token) {
    throw new RuntimeError('internal_token_missing',
      `internal token not readable at ${tokenFile}`);
  }
  return token;
}

// Timing-safe bearer check. Absent/malformed/short tokens fail the same way
// as wrong ones — no early-exit length oracle on the compare itself.
export function tokenMatches(presented, expected) {
  const a = Buffer.from(String(presented ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  const max = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(max), pb = Buffer.alloc(max);
  a.copy(pa); b.copy(pb);
  return a.length === b.length && crypto.timingSafeEqual(pa, pb);
}

export function extractPresentedToken(headers = {}) {
  const h = (k) => headers[k] ?? headers[k.toLowerCase()];
  const direct = h(INTERNAL_TOKEN_HEADER);
  if (typeof direct === 'string' && direct.length) return direct;
  const auth = h('authorization');
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

// HTTP client used by the scheduler. `transport` is injectable for tests:
//   transport({method, path, body, headers}) -> {status, body}
// The default transport is fetch() against the configured base URL. The
// token is sent ONLY as a request header and is never placed into payloads,
// run records, events, or thrown error messages.
export function createInternalClient({
  baseUrl = `http://127.0.0.1:${process.env.EXEC_PORT || 25900}`,
  stateDir,
  token = null,
  transport = null,
} = {}) {
  let cachedToken = token;
  async function authToken() {
    if (!cachedToken) cachedToken = await loadInternalToken(stateDir);
    return cachedToken;
  }

  const doFetch = transport || (async ({ method, path: p, body, headers }) => {
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch { /* raw text */ }
    return { status: res.status, body: parsed ?? text };
  });

  async function request(method, p, body, { internal = false } = {}) {
    const headers = {};
    if (internal) headers[INTERNAL_TOKEN_HEADER] = await authToken();
    const res = await doFetch({ method, path: p, body, headers });
    const b = res.body;
    // The service answers errors with the flat shape
    //   {error: '<message>', code: '<code>', ...details}
    // (errorBody()); preserve status, code, and every extra field as details.
    if (res.status >= 400 || (b && typeof b === 'object' && b.ok === false)) {
      const code = typeof b?.code === 'string' ? b.code : 'request_failed';
      const message =
        (typeof b?.error === 'string' && b.error)
        || (b && typeof b?.error === 'object' && typeof b.error.message === 'string' && b.error.message)
        || `internal request ${method} ${p} -> ${res.status}`;
      const err = new RuntimeError(code, message);
      err.status = res.status;
      if (b && typeof b === 'object') {
        err.details = Object.fromEntries(
          Object.entries(b).filter(([k]) => !['ok', 'error', 'code'].includes(k)));
      }
      throw err;
    }
    return b;
  }

  return {
    // --- reads (public routes; no token) ---
    listCards: () => request('GET', '/api/execution/cards'),
    getCard: (cardId) => request('GET', `/api/execution/cards/${encodeURIComponent(cardId)}`),
    getRun: (runId) => request('GET', `/api/execution/runs/${encodeURIComponent(runId)}`),
    getRunEvents: (runId) =>
      request('GET', `/api/execution/runs/${encodeURIComponent(runId)}/events`),
    getDocument: (cardId, versionId) =>
      request('GET', `/api/execution/cards/${encodeURIComponent(cardId)}/documents/${encodeURIComponent(versionId)}`),
    // P3: the preparation session view — the lead driver reads checkpoint/
    // attempts/gates here; a card without preparation answers 404 → caller
    // maps to null.
    getPreparation: (cardId) =>
      request('GET', `/api/execution/cards/${encodeURIComponent(cardId)}/preparation`),
    // Immutable run artifact bytes — the server verifies the recorded sha256
    // before serving; a corrupt store answers corrupt_store, never bytes.
    getArtifact: (runId, artifactId) =>
      request('GET', `/api/execution/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`),
    // --- internal command channel (token required) ---
    command: (cardId, body) =>
      request('POST', `/api/internal/cards/${encodeURIComponent(cardId)}/commands`,
        body, { internal: true }),
    // Environment identity registration — runner channel (internal token).
    registerEnvironment: (body) =>
      request('POST', '/api/internal/environments/register', body, { internal: true }),
    // Ledger read — the scheduler builds retirement proofs from it.
    getEnvironments: () =>
      request('GET', '/api/internal/environments', undefined, { internal: true }),
    // Environment retirement — OPS channel only. Requires `opsToken` on the
    // client (the host-side key); a runner client that lacks it gets 401.
    retireEnvironment: (body, { opsToken } = {}) =>
      doFetch({
        method: 'POST',
        path: '/api/internal/environments/retire',
        body,
        headers: opsToken ? { 'x-acp-ops-token': opsToken } : {},
      }).then((res) => {
        const b = res.body;
        if (res.status >= 400 || (b && typeof b === 'object' && b.ok === false)) {
          const code = typeof b?.code === 'string' ? b.code : 'request_failed';
          const err = new RuntimeError(code,
            (typeof b?.error === 'string' && b.error)
              || `retire request -> ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return b;
      }),
  };
}
