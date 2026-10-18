import { defineStore } from 'pinia';
import { shallowRef, onScopeDispose } from 'vue';
import { loadKvStore, mutateRemoteDoc, probeStateServer, type KVStore } from '../lib/host/storage';
import { isTauriHost } from '../lib/platform';
import type { SavedSession } from '../lib/types';
import type { ActivityEntry } from './activity';

type Result = 'working' | 'completed' | 'cancelled' | 'error' | null;
export interface SessionStatusSnapshot { status: Result; at: number; }
type Records = Record<string, SessionStatusSnapshot>;
const DOCUMENT = 'session-statuses.json';
const MIRROR = 'acp-ui:session-status-backup';
const keyFor = (agent: string, sessionId: string) => JSON.stringify([agent, sessionId]);

export function mergeSessionStatuses(...sources: unknown[]): Records {
  const merged: Records = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      const row = value as SessionStatusSnapshot | null;
      if (!row || ![null, 'working', 'completed', 'cancelled', 'error'].includes(row.status) || !Number.isFinite(row.at) || row.at <= 0) continue;
      if (!merged[key] || row.at > merged[key].at) merged[key] = row;
    }
  }
  const previous = sources[0] as Records | undefined;
  if (previous && typeof previous === 'object' && !Array.isArray(previous) && Object.keys(previous).length === Object.keys(merged).length
      && Object.keys(merged).every(key => previous[key] === merged[key])) return previous;
  return merged;
}

export function sessionStatusesFromActivity(entries: ActivityEntry[]): Records {
  const records: Records = {};
  const active = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    if (!entry.sessionId || !Number.isFinite(entry.at) || entry.at <= 0) continue;
    const key = keyFor(entry.agentName, entry.sessionId);
    let status: Result;
    if (entry.kind === 'turn-start') { status = 'working'; active.add(key); }
    else if (entry.kind === 'turn-end') status = entry.detail === 'end_turn' ? 'completed' : entry.detail === 'cancelled' ? 'cancelled' : null;
    else if (entry.kind === 'error' && active.has(key)) status = 'error';
    else continue; // Opening/replaying a session is never a new result.
    if (entry.kind !== 'turn-start') active.delete(key);
    if (!records[key] || entry.at >= records[key].at) records[key] = { status, at: entry.at };
  }
  return records;
}

export const useSessionStatusStore = defineStore('session-status', () => {
  const records = shallowRef<Records>({});
  let store: KVStore | null = null;
  let remote = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let writing: Promise<void> | null = null;
  const pending = new Map<string, SessionStatusSnapshot>();

  function mirror() {
    try { globalThis.localStorage?.setItem(MIRROR, JSON.stringify({ statuses: records.value })); } catch { /* Offline storage may be unavailable. */ }
  }
  function forSession(agent: string, sessionId: string) { return records.value[keyFor(agent, sessionId)]; }

  async function flush(): Promise<void> {
    if (!store || writing || pending.size === 0) return writing ?? undefined;
    const batch = Object.fromEntries(pending);
    writing = (async () => {
      let acknowledged = false;
      if (remote) {
        acknowledged = await mutateRemoteDoc(DOCUMENT, data => ({ ...data, statuses: mergeSessionStatuses(data.statuses, batch) }));
      } else {
        await store!.set('statuses', records.value);
        await store!.save();
        acknowledged = true;
      }
      if (acknowledged) {
        for (const [key, row] of Object.entries(batch)) if (pending.get(key) === row) pending.delete(key);
      }
    })().finally(() => { writing = null; });
    await writing;
    // Edits made during the request get their own acknowledgement. Failed
    // requests stay pending for the next sync, without a tight retry loop.
    if (pending.size && Object.entries(batch).some(([key, row]) => pending.get(key) !== row)) await flush();
  }

  function record(session: SavedSession, status: Result) {
    const key = keyFor(session.agentName, session.sessionId);
    const row = { status, at: Math.max(Date.now(), (records.value[key]?.at ?? 0) + 1) };
    records.value = { ...records.value, [key]: row };
    pending.set(key, row);
    mirror();
    void flush();
  }

  async function sync() {
    if (!store) return;
    const merged = mergeSessionStatuses(records.value, await store.get('statuses'));
    if (merged !== records.value) { records.value = merged; mirror(); }
    await flush();
  }

  async function init(entries: ActivityEntry[], sessions: SavedSession[]) {
    let local: unknown;
    try { local = JSON.parse(globalThis.localStorage?.getItem(MIRROR) || '{}').statuses; } catch { local = {}; }
    const legacy: Records = {};
    for (const session of sessions) {
      if (session.lastTurnStatus && session.lastTurnStatus !== 'output') {
        legacy[keyFor(session.agentName, session.sessionId)] = { status: session.lastTurnStatus, at: session.lastMessageAt ?? session.lastUpdated };
      }
    }
    remote = !isTauriHost() && await probeStateServer();
    store = await loadKvStore(DOCUMENT);
    const server = mergeSessionStatuses(await store.get('statuses'));
    // Legacy events have no request identity: a late response to a cancelled
    // turn must never replace an explicitly saved result from the new store.
    const recovered = mergeSessionStatuses(legacy, sessionStatusesFromActivity(entries));
    records.value = { ...recovered, ...mergeSessionStatuses(local, records.value, server) };
    // Earlier clients used null for an unfinished turn. Recover that state
    // only when the turn ledger actually has an unmatched start.
    for (const [key, row] of Object.entries(records.value)) {
      if (row.status === null && recovered[key]?.status === 'working') {
        records.value[key] = { status: 'working', at: Math.max(row.at, recovered[key].at) + 1 };
      }
    }
    for (const [key, row] of Object.entries(records.value)) {
      if (!server[key] || row.at > server[key].at) pending.set(key, row);
    }
    mirror();
    void flush();
    if (typeof window !== 'undefined' && !timer) timer = setInterval(() => void sync(), 5000);
  }
  onScopeDispose(() => { if (timer) clearInterval(timer); });
  return { forSession, record, init, flush };
});
