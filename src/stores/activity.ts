// Activity + usage ledger: the factual history the Board (Timeline/Events),
// Dashboard and Projects views all read from. Everything here comes from the
// ACP protocol (session lifecycle, turns, tool calls, `usage_update`) — never
// invented numbers, and it is the single source other views aggregate over, so
// they never have to touch the session store.
//
// API (stable; other views depend on it):
//   recordEntry({ kind, agentName, sessionId?, cwd?, title?, detail?, value?, cost?, currency? })
//   recent(limit)                  newest first
//   entriesInRange(from, to)       by epoch ms
//   usageInRange(from, to)         raw usage samples
//   totalUsage(from, to)           { tokens, cost, turns }
//   usageByAgent(from, to)         [{ agentName, tokens, cost, turns }]
//   usageByProject(from, to)       [{ project, tokens, cost, turns }]
//   usageByDay(from, to)           [{ day: 'YYYY-MM-DD', tokens, cost, turns }]
//   dayRange(days)                 helpers: { from, to } for common windows
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';

export type ActivityKind =
  | 'session-open'
  | 'session-close'
  | 'connected'
  | 'disconnected'
  | 'turn-start'
  | 'turn-end'
  | 'tool-call'
  | 'usage'
  | 'error'
  | 'lock'
  | 'card'
  | 'sync';

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  agentName: string;
  sessionId?: string;
  cwd?: string;
  title?: string;
  detail?: string;
  /** Token count for `usage`, tool count for `tool-call`, etc. */
  value?: number;
  cost?: number;
  currency?: string;
}

/** One `usage_update` sample from the agent: tokens used against a window. */
export interface UsageSample {
  at: number;
  agentName: string;
  sessionId: string;
  cwd?: string;
  used: number;
  size: number;
  cost?: number;
  currency?: string;
}

/** Last path segment of a working directory — the project's display name. */
export function projectName(cwd?: string): string {
  if (!cwd) return 'unknown';
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

const STORE_PATH = 'activity.json';
const MAX_ENTRIES = 5000;
const MAX_USAGE = 5000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

export const useActivityStore = defineStore('activity', () => {
  const entries = ref<ActivityEntry[]>([]);
  const usage = ref<UsageSample[]>([]);
  let store: KVStore | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const recent = (limit = 50): ActivityEntry[] => entries.value.slice(-limit).reverse();

  function entriesInRange(from: number, to: number): ActivityEntry[] {
    return entries.value.filter((e) => e.at >= from && e.at <= to);
  }

  function usageInRange(from: number, to: number): UsageSample[] {
    return usage.value.filter((u) => u.at >= from && u.at <= to);
  }

  function totalUsage(from: number, to: number): { tokens: number; cost: number; turns: number } {
    const rows = usageInRange(from, to);
    const tokens = rows.reduce((sum, r) => sum + Math.max(0, r.used), 0);
    const cost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
    const turns = entriesInRange(from, to).filter((e) => e.kind === 'turn-end').length;
    return { tokens, cost, turns };
  }

  /** Cost is reported in the agent's own currency; mixed currencies stay separate. */
  function usageByAgent(from: number, to: number) {
    const map = new Map<string, { agentName: string; tokens: number; cost: number; turns: number }>();
    for (const row of usageInRange(from, to)) {
      const acc = map.get(row.agentName) ?? { agentName: row.agentName, tokens: 0, cost: 0, turns: 0 };
      acc.tokens += Math.max(0, row.used);
      acc.cost += row.cost ?? 0;
      map.set(row.agentName, acc);
    }
    const turns = turnsBy(from, to, (e) => e.agentName);
    for (const [key, value] of turns) {
      const acc = map.get(key) ?? { agentName: key, tokens: 0, cost: 0, turns: 0 };
      acc.turns = value;
      map.set(key, acc);
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  function usageByProject(from: number, to: number) {
    const map = new Map<string, { project: string; cwd?: string; tokens: number; cost: number; turns: number }>();
    for (const row of usageInRange(from, to)) {
      const project = projectName(row.cwd);
      const acc = map.get(project) ?? { project, cwd: row.cwd, tokens: 0, cost: 0, turns: 0 };
      acc.tokens += Math.max(0, row.used);
      acc.cost += row.cost ?? 0;
      map.set(project, acc);
    }
    const turns = turnsBy(from, to, (e) => projectName(e.cwd));
    for (const [key, value] of turns) {
      const acc = map.get(key) ?? { project: key, tokens: 0, cost: 0, turns: 0 };
      acc.turns = value;
      map.set(key, acc);
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  function usageByDay(from: number, to: number) {
    const map = new Map<string, { day: string; tokens: number; cost: number; turns: number }>();
    for (const row of usageInRange(from, to)) {
      const day = new Date(row.at).toISOString().slice(0, 10);
      const acc = map.get(day) ?? { day, tokens: 0, cost: 0, turns: 0 };
      acc.tokens += Math.max(0, row.used);
      acc.cost += row.cost ?? 0;
      map.set(day, acc);
    }
    for (const entry of entriesInRange(from, to)) {
      if (entry.kind !== 'turn-end') continue;
      const day = new Date(entry.at).toISOString().slice(0, 10);
      const acc = map.get(day) ?? { day, tokens: 0, cost: 0, turns: 0 };
      acc.turns += 1;
      map.set(day, acc);
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  function turnsBy(
    from: number,
    to: number,
    keyOf: (entry: ActivityEntry) => string
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const entry of entriesInRange(from, to)) {
      if (entry.kind !== 'turn-end') continue;
      const key = keyOf(entry);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }

  function dayRange(days: number): { from: number; to: number } {
    const to = Date.now();
    return { from: to - days * 24 * 60 * 60 * 1000, to };
  }

  function recordEntry(entry: Omit<ActivityEntry, 'id' | 'at'> & { at?: number }): void {
    entries.value.push({ id: nextId(), at: entry.at ?? Date.now(), ...entry });
    if (entries.value.length > MAX_ENTRIES) {
      entries.value = entries.value.slice(-MAX_ENTRIES);
    }
    scheduleSave();
  }

  function recordUsage(sample: Omit<UsageSample, 'at'> & { at?: number }): void {
    // `usage_update` arrives per turn; keeping the last one per session window
    // avoids summing the same running total over and over.
    const at = sample.at ?? Date.now();
    const last = [...usage.value].reverse().find((u) => u.sessionId === sample.sessionId);
    // Skip a sample that repeats the previous one for this session: the agents
    // report a running total, so an unchanged used/size/cost adds nothing.
    const sameCost =
      (sample.cost ?? null) === (last?.cost ?? null) &&
      (sample.currency ?? null) === (last?.currency ?? null);
    if (last && sample.used === last.used && sample.size === last.size && sameCost) {
      return;
    }
    usage.value.push({ at, ...sample });
    if (usage.value.length > MAX_USAGE) usage.value = usage.value.slice(-MAX_USAGE);
    scheduleSave();
  }

  function scheduleSave(): void {
    if (!store || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 1500);
  }

  async function persist(): Promise<void> {
    if (!store) return;
    await store.set('entries', entries.value.slice(-MAX_ENTRIES));
    await store.set('usage', usage.value.slice(-MAX_USAGE));
    await store.save();
  }

  async function initActivityStore(): Promise<void> {
    store = await loadKvStore(STORE_PATH);
    entries.value = (await store.get<ActivityEntry[]>('entries')) ?? [];
    usage.value = (await store.get<UsageSample[]>('usage')) ?? [];
  }

  async function clear(): Promise<void> {
    entries.value = [];
    usage.value = [];
    await persist();
  }

  /**
   * Sessions with a turn that started and has not ended — "working now" as far
   * as this client can see (other machines' turns are invisible here).
   */
  const liveSessions = computed(() => {
    const busy = new Map<string, boolean>();
    for (const entry of entries.value) {
      if (!entry.sessionId) continue;
      if (entry.kind === 'turn-start') busy.set(entry.sessionId, true);
      else if (entry.kind === 'turn-end' || entry.kind === 'error') busy.set(entry.sessionId, false);
    }
    return new Set([...busy.entries()].filter(([, inFlight]) => inFlight).map(([id]) => id));
  });

  return {
    entries,
    usage,
    recent,
    entriesInRange,
    usageInRange,
    totalUsage,
    usageByAgent,
    usageByProject,
    usageByDay,
    dayRange,
    recordEntry,
    recordUsage,
    initActivityStore,
    clear,
    liveSessions,
  };
});
