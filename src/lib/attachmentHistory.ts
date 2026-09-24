// The panel's own record of which files rode along on each user turn.
//
// Why it exists: the agent's session history is the transcript source on
// `session/load`, but agents do not imprint image bytes into the replay — a
// text file's body is echoed inside the message text, an image is not (see
// lib/attachments.ts). Without this record an image the panel sent vanishes
// from the history on reload even though the turn happened.
//
// Where the bytes live: attachment metadata goes into `attachments.json`,
// the same KV document every device on the host shares
// (server/acp-state-server.mjs). That server caps a document at 5 MiB, so
// bytes are inlined ONLY while the serialized doc stays under a budget;
// larger payloads land in a local cache and the record keeps a `cachePath`
// instead — `cache:` is a file under the OS cache dir on Tauri, `local:` a
// localStorage key on web (the browser build has no filesystem of its own;
// localStorage is the only local persistence it has). When neither fits, the
// record keeps metadata + `unavailableReason`, so the transcript still says
// WHICH image is missing and why — never a silent gap.
//
// Correlation: entries are keyed by user-turn ordinal (the Nth user message
// in the session), so a replayed `user_message_chunk` finds its files by
// position regardless of which device sent them.

import { loadKvStore, type KVStore } from './host/storage';
import { isTauriHost } from './platform';
import { uuid } from './uuid';
import type { Attachment, AttachmentMeta } from './types';

const STORE_NAME = 'attachments.json';
const DOC_KEY = 'doc';

/**
 * Per-attachment inline budget in the shared doc. A 4 MiB image is ~5.4 MB of
 * base64 — over the server's cap by itself — so anything above this goes to
 * the local cache instead of the document.
 */
const MAX_INLINE_CHARS = 768 * 1024;
/**
 * Whole-document budget, comfortably under the state server's 5 MiB 413.
 * `save()` also mirrors to localStorage, so pushing the limit would break
 * the mirror first.
 */
const MAX_DOC_CHARS = 3 * 1024 * 1024;

interface SessionAttachmentRecord {
  updatedAt: number;
  /** user-turn ordinal (1-based, as string keys) -> attachment metas. */
  turns: Record<string, AttachmentMeta[]>;
}

interface AttachmentDoc {
  version: 1;
  sessions: Record<string, SessionAttachmentRecord>;
}

let kv: KVStore | null = null;
let doc: AttachmentDoc | null = null;
let loading: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (doc) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      kv = await loadKvStore(STORE_NAME);
      const stored = await kv.get<AttachmentDoc>(DOC_KEY);
      doc =
        stored && typeof stored === 'object' && stored.sessions
          ? stored
          : { version: 1, sessions: {} };
    })();
  }
  return loading;
}

/** Called once from the session store's init. */
export async function loadAttachmentHistory(): Promise<void> {
  await ensureLoaded();
}

/** Metas recorded for the Nth user turn of a session ([] when unknown). */
export function turnAttachments(
  sessionId: string,
  userTurnIndex: number
): AttachmentMeta[] {
  return doc?.sessions[sessionId]?.turns[String(userTurnIndex)] ?? [];
}

// ---------------------------------------------------------------------------
// Local byte cache for payloads too big for the shared doc
// ---------------------------------------------------------------------------

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Best-effort write of an attachment's bytes to the local cache. Returns the
 * `cachePath` to store in the record, or null when this host has nowhere to
 * put them (the caller then keeps only metadata + a reason).
 */
async function cacheAttachmentBytes(
  sessionId: string,
  att: Attachment
): Promise<string | null> {
  const key = `${sessionId}-${uuid()}`;
  if (isTauriHost()) {
    try {
      const { mkdir, writeFile, BaseDirectory } = await import(
        '@tauri-apps/plugin-fs'
      );
      const dir = `attachments/${safeName(sessionId)}`;
      await mkdir(dir, { baseDir: BaseDirectory.AppCache, recursive: true });
      const rel = `${dir}/${key}-${safeName(att.name)}`;
      // Image `data` is already base64; text files store their raw text —
      // resolveCachedBytes rebuilds the right shape from mimeType on read.
      const bytes =
        att.kind === 'image'
          ? base64ToBytes(att.data)
          : new TextEncoder().encode(att.data);
      await writeFile(rel, bytes, { baseDir: BaseDirectory.AppCache });
      return `cache:${rel}`;
    } catch (e) {
      console.warn('attachment cache write failed:', e);
      return null;
    }
  }
  // Web: no filesystem — localStorage is the only local byte store. It is
  // also ~5 MB per origin, so this can legitimately fail on quota; the
  // caller then records the file without bytes (placeholder, not a gap).
  try {
    const value =
      att.kind === 'image'
        ? att.previewUrl ?? `data:${att.mimeType};base64,${att.data}`
        : att.data;
    localStorage.setItem(`acp-ui:att-cache:${key}`, value);
    return `local:${key}`;
  } catch {
    return null;
  }
}

/**
 * Fill `meta.previewUrl`/`meta.body` from the local cache, or set an honest
 * `unavailableReason` when the cached copy is gone. Mutates the passed meta —
 * callers rely on Vue reactivity picking the change up.
 */
export async function resolveCachedBytes(meta: AttachmentMeta): Promise<void> {
  const ref = meta.cachePath;
  if (!ref || meta.previewUrl || meta.body) return;
  try {
    if (ref.startsWith('local:')) {
      const value = localStorage.getItem(`acp-ui:att-cache:${ref.slice(6)}`);
      if (value != null) {
        if (meta.kind === 'image') meta.previewUrl = value;
        else meta.body = value;
      } else {
        meta.unavailableReason =
          'the local cached copy is gone (storage was cleared)';
      }
      return;
    }
    if (ref.startsWith('cache:') && isTauriHost()) {
      const { readFile, BaseDirectory } = await import(
        '@tauri-apps/plugin-fs'
      );
      const bytes = await readFile(ref.slice(6), {
        baseDir: BaseDirectory.AppCache,
      });
      if (meta.kind === 'image') {
        meta.previewUrl = `data:${meta.mimeType};base64,${bytesToBase64(bytes)}`;
      } else {
        meta.body = new TextDecoder().decode(bytes);
      }
      return;
    }
    meta.unavailableReason = 'the cached copy is not readable on this host';
  } catch {
    meta.unavailableReason = 'the cached copy could not be read';
  }
}

// ---------------------------------------------------------------------------
// Recording + pruning
// ---------------------------------------------------------------------------

/**
 * Strip bytes from the oldest records until the doc serializes under
 * MAX_DOC_CHARS. Metadata always stays — an evicted file becomes a named
 * placeholder ("dropped from the shared record"), never a silent gap.
 */
function prune(): void {
  if (!doc) return;
  const serialized = () => JSON.stringify(doc).length;
  if (serialized() <= MAX_DOC_CHARS) return;
  const evict = 'dropped from the shared record to stay under the size cap';
  // Oldest sessions first; inside a session, oldest turns first.
  const sessions = Object.entries(doc.sessions).sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  for (const [, rec] of sessions) {
    for (const key of Object.keys(rec.turns).sort((a, b) => Number(a) - Number(b))) {
      for (const meta of rec.turns[key]) {
        if (serialized() <= MAX_DOC_CHARS) return;
        if (meta.previewUrl || meta.body) {
          delete meta.previewUrl;
          delete meta.body;
          meta.unavailableReason = evict;
        }
      }
    }
  }
  // Still too big (all metadata, no bytes left): drop whole oldest sessions.
  for (const [sid] of sessions) {
    if (serialized() <= MAX_DOC_CHARS) return;
    delete doc.sessions[sid];
  }
}

async function save(): Promise<void> {
  if (!kv || !doc) return;
  await kv.set(DOC_KEY, doc);
  await kv.save();
}

/**
 * Persist one sent turn's attachments. Bytes go inline when small, to the
 * local cache when they would blow the shared document, and nowhere (with an
 * explicit reason) when neither is possible.
 */
export async function recordTurnAttachments(
  sessionId: string,
  userTurnIndex: number,
  attachments: Attachment[]
): Promise<void> {
  if (!attachments.length) return;
  await ensureLoaded();
  if (!doc) return;

  const metas: AttachmentMeta[] = [];
  for (const att of attachments) {
    const meta: AttachmentMeta = {
      name: att.name,
      kind: att.kind,
      mimeType: att.mimeType,
      size: att.size,
    };
    if (att.kind === 'image') {
      const dataUrl = att.previewUrl ?? `data:${att.mimeType};base64,${att.data}`;
      if (dataUrl.length <= MAX_INLINE_CHARS) {
        meta.previewUrl = dataUrl;
      } else {
        const ref = await cacheAttachmentBytes(sessionId, att);
        if (ref) meta.cachePath = ref;
        else
          meta.unavailableReason =
            'image too large for the shared state doc and no local cache was available';
      }
    } else {
      if ((att.data?.length ?? 0) <= MAX_INLINE_CHARS) {
        meta.body = att.data;
      } else {
        const ref = await cacheAttachmentBytes(sessionId, att);
        if (ref) meta.cachePath = ref;
        else
          meta.unavailableReason =
            'file too large for the shared state doc and no local cache was available';
      }
    }
    metas.push(meta);
  }

  const rec = (doc.sessions[sessionId] ??= { updatedAt: 0, turns: {} });
  rec.updatedAt = Date.now();
  rec.turns[String(userTurnIndex)] = metas;
  prune();
  await save();
}

/** Drop a session's records (the user deleted it from the sidebar). */
export async function forgetSessionAttachments(sessionId: string): Promise<void> {
  await ensureLoaded();
  if (!doc || !doc.sessions[sessionId]) return;
  delete doc.sessions[sessionId];
  await save();
}
