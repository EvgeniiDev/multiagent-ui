// Tail cache for session history — the "open on the newest instantly" store.
//
// Why it exists: ACP `session/load` replays the WHOLE transcript top-down —
// LoadSessionRequest is just `{cwd, mcpServers, sessionId}` (no offset/limit)
// and the `*_message_chunk` notifications carry no sequence numbers, so there
// is no protocol-level way to ask the agent for "the last 20". The newest
// message can only appear instantly if the client already holds it: this
// module keeps the last ~100 messages of each session in localStorage, keyed
// `acp-ui:history:<agent>::<sessionId>`.
//
// The cache is write-through: the session store persists the rendered tail
// after every settled turn and (throttled) while a replay streams. On open,
// the cached tail renders immediately under a "loading history…" marker; the
// live replay is still the source of truth and reconciles/drops the entry at
// `session/load` resolve — that logic lives in `stores/session.ts`, this file
// only owns the storage.
//
// Attachments are stored as AttachmentMeta WITHOUT bytes (previewUrl/body are
// stripped on write; `cachePath` pointers survive and resolve lazily on open,
// so images render exactly as they do on a replay). localStorage failures —
// quota, private mode — must never break the chat: every write is swallowed.

import type { ChatMessage } from './types';

const PREFIX = 'acp-ui:history:';
const VERSION = 1;

/** Keep at most this many tail messages per session (oldest dropped first). */
export const HISTORY_TAIL_MESSAGES = 100;
const MAX_ENTRY_CHARS = 512 * 1024;
const MAX_TOOL_DETAIL_CHARS = 16 * 1024;
/** Entries not opened within this window are evicted on store init. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Whole-cache budget; oldest sessions are evicted first when over it. */
const MAX_TOTAL_CHARS = 2 * 1024 * 1024;

export interface HistoryCacheEntry {
  version: 1;
  savedAt: number;
  /**
   * User-turn ordinal of the tail's first user message minus one — i.e. how
   * many user turns lived BELOW the tail when it was written. The attachment
   * record correlates files by user-turn ordinal in the full transcript; a
   * truncated tail can't recount them without the offset.
   */
  userTurnBase: number;
  messages: ChatMessage[];
}

export function historyCacheKey(agentName: string, sessionId: string): string {
  return `${PREFIX}${agentName}::${sessionId}`;
}

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

/**
 * Copy `messages` into a cache-safe shape: capped to the tail, and with
 * attachment bytes removed (`previewUrl`/`body` can each be ~1 MiB of data
 * URL — a handful of images would blow the 2 MiB cache budget alone).
 */
function toCachedMessages(messages: ChatMessage[]): ChatMessage[] {
  return tailOf(messages).map((m) => ({
    ...m,
    toolCalls: m.toolCalls?.map((t) => {
      const cached = { ...t };
      // Large tool bodies are restored by the background replay; headings,
      // identities and status are enough to paint the cached feed quickly.
      if ((cached.rawOutput?.length ?? 0) > MAX_TOOL_DETAIL_CHARS) delete cached.rawOutput;
      if (cached.rawInput && JSON.stringify(cached.rawInput).length > MAX_TOOL_DETAIL_CHARS) delete cached.rawInput;
      return cached;
    }),
    attachments: m.attachments?.map((a) => {
      const cached: typeof a = { ...a };
      delete cached.previewUrl;
      delete cached.body;
      return cached;
    }),
  }));
}

function tailOf(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-HISTORY_TAIL_MESSAGES);
}

function countUser(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0);
}

/** Read the cached tail, or null when absent/corrupt. Never throws. */
export function readHistoryCache(
  agentName: string,
  sessionId: string
): HistoryCacheEntry | null {
  if (!storageAvailable()) return null;
  try {
    const raw = localStorage.getItem(historyCacheKey(agentName, sessionId));
    if (!raw) return null;
    const entry = JSON.parse(raw) as HistoryCacheEntry;
    if (!entry || entry.version !== VERSION || !Array.isArray(entry.messages)) {
      return null;
    }
    if (typeof entry.userTurnBase !== 'number') entry.userTurnBase = 0;
    return entry;
  } catch (e) {
    console.warn('history cache read failed:', e);
    return null;
  }
}

/** Persist the tail of `messages`. Never throws (quota/private mode). */
export function storeHistoryCacheEntry(agentName: string, sessionId: string, entry: HistoryCacheEntry): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(historyCacheKey(agentName, sessionId), JSON.stringify(entry));
  } catch (e) {
    console.warn('history cache write failed:', e);
  }
}

export function writeHistoryCache(
  agentName: string,
  sessionId: string,
  messages: ChatMessage[]
): HistoryCacheEntry | null {
  if (messages.length === 0) return null;
  const entry: HistoryCacheEntry = {
    version: VERSION, savedAt: Date.now(),
    userTurnBase: countUser(messages) - countUser(tailOf(messages)),
    messages: toCachedMessages(messages),
  };
  while (entry.messages.length > 1 && JSON.stringify(entry).length > MAX_ENTRY_CHARS) {
    if (entry.messages.shift()?.role === 'user') entry.userTurnBase++;
  }
  if (JSON.stringify(entry).length > MAX_ENTRY_CHARS) return null;
  storeHistoryCacheEntry(agentName, sessionId, entry);
  return entry;
}

/** Forget one session's tail (diverged replay, deleted session). */
export function dropHistoryCache(agentName: string, sessionId: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.removeItem(historyCacheKey(agentName, sessionId));
  } catch {
    /* never fatal */
  }
}

interface ListedEntry {
  key: string;
  savedAt: number;
  chars: number;
  valid: boolean;
}

function listEntries(): ListedEntry[] {
  const out: ListedEntry[] = [];
  if (!storageAvailable()) return out;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key) ?? '';
      let savedAt = 0;
      let valid = false;
      try {
        const entry = JSON.parse(raw) as HistoryCacheEntry;
        valid =
          !!entry && entry.version === VERSION && Array.isArray(entry.messages);
        savedAt = typeof entry?.savedAt === 'number' ? entry.savedAt : 0;
      } catch {
        /* corrupt entry counts as invalid — evicted below */
      }
      out.push({ key, savedAt, chars: raw.length, valid });
    }
  } catch {
    /* a throwing localStorage iteration just reports nothing */
  }
  return out;
}

export interface HistoryCacheStats {
  entries: number;
  chars: number;
}

export interface EvictionResult extends HistoryCacheStats {
  removed: number;
}

/**
 * Init-time hygiene: drop entries not opened in >7 days, corrupt/foreign
 * entries, then cap the whole cache at ~2 MiB by dropping the oldest
 * sessions first. Runs once from the session store's init.
 */
export function evictHistoryCaches(now: number = Date.now()): EvictionResult {
  const entries = listEntries();
  let removed = 0;
  const live: ListedEntry[] = [];
  for (const e of entries) {
    if (!e.valid || now - e.savedAt > MAX_AGE_MS) {
      try {
        localStorage.removeItem(e.key);
      } catch {
        /* ignore */
      }
      removed++;
    } else {
      live.push(e);
    }
  }
  // Cap total size — oldest `savedAt` goes first.
  let chars = live.reduce((n, e) => n + e.chars, 0);
  live.sort((a, b) => a.savedAt - b.savedAt);
  for (const e of live) {
    if (chars <= MAX_TOTAL_CHARS) break;
    try {
      localStorage.removeItem(e.key);
    } catch {
      /* ignore */
    }
    chars -= e.chars;
    removed++;
    e.savedAt = -1; // excluded from the kept count below
  }
  const kept = live.filter((e) => e.savedAt >= 0);
  return {
    removed,
    entries: kept.length,
    chars: kept.reduce((n, e) => n + e.chars, 0),
  };
}

/** Report shape for diagnostics/e2e: how many tails and how big. */
export function historyCacheStats(): HistoryCacheStats {
  const entries = listEntries();
  return {
    entries: entries.length,
    chars: entries.reduce((n, e) => n + e.chars, 0),
  };
}
