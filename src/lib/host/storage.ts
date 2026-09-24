// Minimal KV-store shim with pluggable persistence:
//  - on Tauri, defers to `@tauri-apps/plugin-store` so behaviour matches
//    today's persistence (keyed JSON file in the app's data dir);
//  - on web, if the host's state server answers
//    `GET http://<hostname>:25900/health` (probed once per session), keeps
//    each document on the server so every device on the host reads/writes
//    the same state — with localStorage as an always-on mirror;
//  - otherwise uses `localStorage` under a single `acp-ui:<name>` namespace.
//
// The exposed shape mirrors the subset of `plugin-store` we actually use
// (`get`, `set`, `save`) so we can swap backends without touching call
// sites in the session/preferences stores.

import { isTauriHost } from '../platform';

export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

// ---------------------------------------------------------------------------
// localStorage helpers (web backend + offline mirror for the remote backend)
// ---------------------------------------------------------------------------

function localKey(name: string): string {
  return `acp-ui:${name}`;
}

function readLocalData(key: string): Record<string, unknown> {
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(key);
  if (!raw) return {};
  try {
    return (JSON.parse(raw) as Record<string, unknown>) ?? {};
  } catch (e) {
    console.warn(`Failed to parse ${key} from localStorage:`, e);
    return {};
  }
}

function writeLocalData(key: string, data: Record<string, unknown>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    // Quota exceeded, private mode, etc. — surface to the console; the
    // session/preferences code already tolerates a missing store.
    console.warn(`Failed to persist ${key} to localStorage:`, e);
  }
}

class WebKVStore implements KVStore {
  private readonly storageKey: string;
  private data: Record<string, unknown>;

  constructor(name: string) {
    this.storageKey = localKey(name);
    this.data = readLocalData(this.storageKey);
  }

  async get<T>(key: string): Promise<T | null> {
    const v = this.data[key];
    return (v === undefined ? null : (v as T));
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
  }

  async save(): Promise<void> {
    writeLocalData(this.storageKey, this.data);
  }
}

// ---------------------------------------------------------------------------
// Shared state server (server/acp-state-server.mjs on the host, port 25900)
// ---------------------------------------------------------------------------

const STATE_SERVER_PORT = 25900;
const HEALTH_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 4000;
const POLL_INTERVAL_MS = 5000;

// `VITE_STATE_URL` overrides the whole base URL at build time (tests,
// non-standard deployments); default is the host that served this bundle.
function stateServerBase(): string {
  const env = import.meta.env?.VITE_STATE_URL as string | undefined;
  if (env) return env.replace(/\/+$/, '');
  const hostname =
    (typeof location !== 'undefined' && location.hostname) || '127.0.0.1';
  return `http://${hostname}:${STATE_SERVER_PORT}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The probe is session-scoped: one answer decides the backend for every
// `loadKvStore` call on this page — no re-probing per store.
let healthProbe: Promise<boolean> | null = null;

function probeStateServer(): Promise<boolean> {
  if (!healthProbe) {
    healthProbe = (async () => {
      try {
        const res = await fetchWithTimeout(
          `${stateServerBase()}/health`, {}, HEALTH_TIMEOUT_MS,
        );
        if (!res.ok) return false;
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        return body?.ok === true;
      } catch {
        return false;
      }
    })();
  }
  return healthProbe;
}

interface RemoteDoc {
  rev: number;
  updatedAt: number;
  data: Record<string, unknown>;
}

type DocFetch = RemoteDoc | 'missing' | 'error';

/**
 * Server-backed store. The server document is authoritative; a localStorage
 * copy is kept in lockstep so the app keeps working (read and write) when
 * the server is unreachable — edits made while offline are pushed once a
 * poll sees the server again.
 *
 * Convergence is last-write-wins on `updatedAt`: a 5 s poll adopts the
 * remote document whenever it is newer, unless the store holds unsaved
 * edits (`dirty`) — incoming state never clobbers those.
 */
class RemoteKVStore implements KVStore {
  private readonly name: string;
  private readonly base: string;
  private readonly storageKey: string;
  private data: Record<string, unknown> = {};
  private rev = 0;
  private updatedAt = 0;   // server stamp of the doc we last adopted/wrote
  private touchedAt = 0;   // local clock of the newest `set()`
  private dirty = false;   // local edits not yet confirmed by the server
  private down = false;    // server unreachable — localStorage-only mode
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(name: string, base: string) {
    this.name = name;
    this.base = base;
    this.storageKey = localKey(name);
  }

  static async open(name: string, base: string): Promise<RemoteKVStore> {
    const store = new RemoteKVStore(name, base);
    const remote = await store.fetchDoc();
    if (remote === 'error') {
      // The server died between the health probe and the first read —
      // start from the localStorage copy; the poll re-syncs on recovery.
      store.down = true;
      store.data = readLocalData(store.storageKey);
    } else if (remote === 'missing') {
      // Migration: nothing on the server yet but the browser may hold a
      // document — push it up so no device loses its state.
      store.data = readLocalData(store.storageKey);
      if (Object.keys(store.data).length > 0) {
        store.dirty = true;
        store.touchedAt = Date.now();
        await store.push();
      }
    } else {
      store.adopt(remote);
    }
    setInterval(() => void store.reload(), POLL_INTERVAL_MS);
    return store;
  }

  async get<T>(key: string): Promise<T | null> {
    const v = this.data[key];
    return (v === undefined ? null : (v as T));
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    this.touchedAt = Date.now();
    this.dirty = true;
  }

  async save(): Promise<void> {
    // The mirror is always written first: if the server is gone the edits
    // still survive a reload, and the next poll ships them.
    writeLocalData(this.storageKey, this.data);
    if (this.down) return;
    await this.enqueue(() => this.push());
  }

  // -- internals ------------------------------------------------------------

  // Serializes network ops so a poll can't interleave with an in-flight
  // PUT. Jobs are expected to swallow their own errors; the catch is a
  // last-resort guard so `save()` never throws into the stores.
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => job().catch(() => {}));
    this.queue = next;
    return next;
  }

  private async fetchDoc(): Promise<DocFetch> {
    try {
      const res = await fetchWithTimeout(
        `${this.base}/api/state/${encodeURIComponent(this.name)}`,
        {},
        REQUEST_TIMEOUT_MS,
      );
      if (res.status === 404) return 'missing';
      if (!res.ok) return 'error';
      const body = (await res.json().catch(() => null)) as Partial<RemoteDoc> | null;
      if (!body || typeof body !== 'object') return 'error';
      return {
        rev: typeof body.rev === 'number' ? body.rev : 0,
        updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : 0,
        data:
          body.data && typeof body.data === 'object'
            ? (body.data as Record<string, unknown>)
            : {},
      };
    } catch {
      return 'error';
    }
  }

  private async putRemote(force: boolean): Promise<'ok' | 'conflict' | 'error'> {
    const body: { data: unknown; rev?: number } = { data: this.data };
    if (!force) body.rev = this.rev;
    try {
      const res = await fetchWithTimeout(
        `${this.base}/api/state/${encodeURIComponent(this.name)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        REQUEST_TIMEOUT_MS,
      );
      if (res.ok) {
        const r = (await res.json().catch(() => null)) as {
          rev?: number;
          updatedAt?: number;
        } | null;
        if (r && typeof r.rev === 'number') this.rev = r.rev;
        if (r && typeof r.updatedAt === 'number') this.updatedAt = r.updatedAt;
        return 'ok';
      }
      return res.status === 409 ? 'conflict' : 'error';
    } catch {
      return 'error';
    }
  }

  private adopt(doc: RemoteDoc): void {
    this.data = doc.data;
    this.rev = doc.rev;
    this.updatedAt = doc.updatedAt;
    this.touchedAt = doc.updatedAt;
    this.dirty = false;
    writeLocalData(this.storageKey, this.data);
  }

  // Push the local document. On a rev conflict the later `updatedAt` wins:
  // adopt the remote copy when it is newer than our newest local edit,
  // otherwise overwrite it.
  private async push(): Promise<void> {
    const sentTouchedAt = this.touchedAt;
    let res = await this.putRemote(false);
    if (res === 'conflict') {
      const remote = await this.fetchDoc();
      if (
        remote !== 'error' &&
        remote !== 'missing' &&
        remote.updatedAt > this.touchedAt
      ) {
        this.adopt(remote);
        return;
      }
      res = await this.putRemote(true);
    }
    if (res === 'ok') {
      // A `set()` that raced the in-flight PUT bumped `touchedAt` — keep the
      // store dirty so the next push still ships that edit.
      if (this.touchedAt === sentTouchedAt) this.dirty = false;
    } else if (res === 'error') {
      this.down = true;
    }
  }

  // Poll body: adopt the remote document when it is newer, unless local
  // edits are still unsaved — those win until pushed.
  private async reload(): Promise<void> {
    await this.enqueue(async () => {
      const remote = await this.fetchDoc();
      if (remote === 'error') {
        this.down = true;
        return;
      }
      this.down = false;
      if (this.dirty) {
        // Push unconditionally — the conflict path inside push() resolves
        // a newer remote by adopting it (or force-puts when the local edit
        // is newer). Skipping the push when the remote is newer wedges the
        // store for good: `dirty` never clears and no remote document is
        // ever adopted again.
        await this.push();
        return;
      }
      if (remote !== 'missing' && remote.updatedAt > this.updatedAt) {
        this.adopt(remote);
      }
    });
  }
}

/**
 * Rev-safe read-modify-write on a shared state document — the same
 * GET -> mutate -> PUT-with-rev -> retry-on-409 protocol the runner's
 * `mutate()` and boardctl use (server/acp-runner.mjs, scripts/boardctl).
 * `fn` receives the current document and returns the next one, or `null`
 * to abort the write. Returns false when no state server is reachable —
 * callers then fall back to the KV store path (Tauri / offline web).
 */
export async function mutateRemoteDoc(
  name: string,
  fn: (data: Record<string, unknown>) => Record<string, unknown> | null,
  tries = 6,
): Promise<boolean> {
  if (isTauriHost() || !(await probeStateServer())) return false;
  const base = stateServerBase();
  const url = `${base}/api/state/${encodeURIComponent(name)}`;
  for (let i = 0; i < tries; i++) {
    let data: Record<string, unknown> = {};
    let rev = 0;
    try {
      const res = await fetchWithTimeout(url, {}, REQUEST_TIMEOUT_MS);
      if (res.status === 404) {
        data = {};
        rev = 0;
      } else if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          data?: Record<string, unknown>;
          rev?: number;
        } | null;
        if (!body || typeof body !== 'object') return false;
        data = body.data && typeof body.data === 'object' ? body.data : {};
        rev = typeof body.rev === 'number' ? body.rev : 0;
      } else {
        return false;
      }
    } catch {
      return false;
    }
    const next = fn(structuredClone(data));
    if (next === null) return true;
    try {
      const put = await fetchWithTimeout(
        url,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: next, rev }),
        },
        REQUEST_TIMEOUT_MS,
      );
      if (put.ok) return true;
      if (put.status === 409) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

// Web stores are cached per document name so every call site shares one
// in-memory view (and one poll timer) for e.g. `preferences.json`.
const webStores = new Map<string, Promise<KVStore>>();

/**
 * Open (or create) a persistent KV store. Returns an interface that matches
 * the slice of `@tauri-apps/plugin-store` we use today.
 */
export async function loadKvStore(name: string): Promise<KVStore> {
  if (isTauriHost()) {
    // Defer the import so the web bundle doesn't pay for it. Vite turns
    // this into a separate chunk that's only fetched on Tauri.
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(name);
    return {
      async get<T>(key: string): Promise<T | null> {
        const v = await store.get<T>(key);
        return v === undefined ? null : v;
      },
      set: (key, value) => store.set(key, value),
      save: () => store.save(),
    };
  }
  let pending = webStores.get(name);
  if (!pending) {
    pending = (async (): Promise<KVStore> =>
      (await probeStateServer())
        ? RemoteKVStore.open(name, stateServerBase())
        : new WebKVStore(name))();
    webStores.set(name, pending);
  }
  return pending;
}
