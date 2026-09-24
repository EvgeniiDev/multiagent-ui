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
  | 'permission'
  | 'usage'
  | 'error'
  | 'lock'
  | 'card'
  | 'delegate'
  | 'sync';

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  agentName: string;
  sessionId?: string;
  /** Role the dispatcher ran under, on `card` events it wrote. */
  role?: string;
  cwd?: string;
  title?: string;
  detail?: string;
  /** Token count for `usage`, tool count for `tool-call`, etc. */
  value?: number;
  cost?: number;
  currency?: string;
  /** Delegation facts (kind === 'delegate'): the subagent this event is
   * about. `title` carries the human label; `subagent` is the stable key
   * start/finish events correlate on (defaults to `title` when absent). */
  subagent?: string;
  /** Lifecycle state this event asserts for the subagent. */
  subState?: 'running' | 'done' | 'failed' | 'cancelled';
  /** What the subagent was asked to do (spawn events). */
  goal?: string;
  /** Epoch ms the subagent stopped (terminal events). */
  endedAt?: number;
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
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  const recent = (limit = 50): ActivityEntry[] => entries.value.slice(-limit).reverse();

  function entriesInRange(from: number, to: number): ActivityEntry[] {
    return entries.value.filter((e) => e.at >= from && e.at <= to);
  }

  function usageInRange(from: number, to: number): UsageSample[] {
    return usage.value.filter((u) => u.at >= from && u.at <= to);
  }

  /**
   * Consumed tokens/cost inside [from, to], attributed as per-session DELTAS.
   *
   * `used`/`cost` are a session's RUNNING totals (that is what `usage_update`
   * carries), so summing every sample multiplies a session by its sample count —
   * measured on live data: a session that spent nothing in a day still added its
   * entire running total to that day, and a day with four samples inflated ~4x.
   *
   * For each session: the last cumulative value at or before `to`, minus the last
   * value before `from`. A session first seen inside the window is baselined at its
   * first in-window sample, so nothing is attributed for the time before we knew it.
   */
  function consumedInRange(
    from: number,
    to: number
  ): { tokens: number; cost: number; sessions: number } {
    const bySession = new Map<string, { before: UsageSample | null; inside: UsageSample[] }>();
    for (const row of usage.value) {
      const key = row.sessionId ?? `${row.agentName}:${row.cwd ?? ''}`;
      const acc = bySession.get(key) ?? { before: null, inside: [] };
      if (row.at < from) {
        if (!acc.before || row.at > acc.before.at) acc.before = row;
      } else if (row.at <= to) {
        acc.inside.push(row);
      }
      bySession.set(key, acc);
    }
    let tokens = 0;
    let cost = 0;
    let sessions = 0;
    for (const { before, inside } of bySession.values()) {
      if (!inside.length) continue;
      sessions += 1;
      inside.sort((a, b) => a.at - b.at);
      // Baseline: what the session had already spent when the window opened. With
      // no earlier sample the session is new to us, so its total counts once —
      // never once per sample, which is what made a day read x4.
      const baseTokens = before ? Math.max(0, before.used) : 0;
      const baseCost = before ? before.cost ?? 0 : 0;
      const endTokens = Math.max(0, inside[inside.length - 1].used);
      const endCost = inside[inside.length - 1].cost ?? 0;
      tokens += Math.max(0, endTokens - baseTokens);
      cost += Math.max(0, endCost - baseCost);
    }
    return { tokens, cost, sessions };
  }

  /**
   * Per-session delta rows: one row per session with what it actually consumed in
   * the window, tagged with the agent and cwd of its LAST in-window sample (the
   * row that defines the end of the measured interval).
   */
  function deltaRows(
    from: number,
    to: number
  ): { agentName: string; cwd?: string; sessionId?: string; tokens: number; cost: number }[] {
    const bySession = new Map<string, UsageSample[]>();
    for (const row of usage.value) {
      if (row.at > to) continue;
      const key = row.sessionId ?? `${row.agentName}:${row.cwd ?? ''}`;
      const list = bySession.get(key) ?? [];
      list.push(row);
      bySession.set(key, list);
    }
    const out: { agentName: string; cwd?: string; sessionId?: string; tokens: number; cost: number }[] = [];
    for (const list of bySession.values()) {
      list.sort((a, b) => a.at - b.at);
      const inside = list.filter((r) => r.at >= from);
      if (!inside.length) continue;
      const before = [...list].reverse().find((r) => r.at < from) ?? null;
      const last = inside[inside.length - 1];
      const baseTokens = before ? Math.max(0, before.used) : 0;
      const baseCost = before ? before.cost ?? 0 : 0;
      out.push({
        agentName: last.agentName,
        cwd: last.cwd,
        sessionId: last.sessionId,
        tokens: Math.max(0, Math.max(0, last.used) - baseTokens),
        cost: Math.max(0, (last.cost ?? 0) - baseCost),
      });
    }
    return out;
  }

  /**
   * The same delta accounting, bucketed per calendar day — the basis for the
   * dashboard's chart and its table (a day can only gain what grew that day).
   */
  function consumedByDay(
    from: number,
    to: number
  ): Map<string, { tokens: number; cost: number }> {
    const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const bySession = new Map<string, UsageSample[]>();
    for (const row of usage.value) {
      if (row.at > to) continue;
      const key = row.sessionId ?? `${row.agentName}:${row.cwd ?? ''}`;
      const list = bySession.get(key) ?? [];
      list.push(row);
      bySession.set(key, list);
    }
    const out = new Map<string, { tokens: number; cost: number }>();
    for (const list of bySession.values()) {
      list.sort((a, b) => a.at - b.at);
      // last cumulative value per day for this session
      const perDay = new Map<string, UsageSample>();
      for (const row of list) perDay.set(dayKey(row.at), row);
      // Baseline: exact when the session was already spending before the window;
      // otherwise zero, so a session new to us contributes its total exactly once.
      const prior = [...list].reverse().find((r) => r.at < from);
      let seenTokens = prior ? Math.max(0, prior.used) : 0;
      let seenCost = prior ? prior.cost ?? 0 : 0;
      for (const day of [...perDay.keys()].sort()) {
        const row = perDay.get(day)!;
        const tokens = Math.max(0, Math.max(0, row.used) - seenTokens);
        const cost = Math.max(0, (row.cost ?? 0) - seenCost);
        seenTokens = Math.max(seenTokens, Math.max(0, row.used));
        seenCost = Math.max(seenCost, row.cost ?? 0);
        if (day < dayKey(from)) continue;
        const acc = out.get(day) ?? { tokens: 0, cost: 0 };
        acc.tokens += tokens;
        acc.cost += cost;
        out.set(day, acc);
      }
    }
    return out;
  }

  function totalUsage(from: number, to: number): { tokens: number; cost: number; turns: number } {
    const { tokens, cost } = consumedInRange(from, to);
    const turns = entriesInRange(from, to).filter((e) => e.kind === 'turn-end').length;
    return { tokens, cost, turns };
  }

  /** Cost is reported in the agent's own currency; mixed currencies stay separate. */
  function usageByAgent(from: number, to: number) {
    const map = new Map<string, { agentName: string; tokens: number; cost: number; turns: number }>();
    for (const row of deltaRows(from, to)) {
      const acc = map.get(row.agentName) ?? { agentName: row.agentName, tokens: 0, cost: 0, turns: 0 };
      acc.tokens += row.tokens;
      acc.cost += row.cost;
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
    for (const row of deltaRows(from, to)) {
      const project = projectName(row.cwd);
      const acc = map.get(project) ?? { project, cwd: row.cwd, tokens: 0, cost: 0, turns: 0 };
      acc.tokens += row.tokens;
      acc.cost += row.cost;
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
    for (const [day, consumed] of consumedByDay(from, to)) {
      map.set(day, { day, tokens: consumed.tokens, cost: consumed.cost, turns: 0 });
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

  // The server-side doc gains entries from other writers too (boardctl,
  // the runner, agents on other devices); RemoteKVStore adopts the newer
  // doc on its own poll, but this ref was filled once at init. A periodic
  // re-read + id-merge keeps it in step without dropping locally recorded
  // rows that haven't been pushed yet.
  async function syncEntries(): Promise<void> {
    if (!store) return;
    const remote = (await store.get<ActivityEntry[]>('entries')) ?? [];
    const byId = new Map(entries.value.map((e) => [e.id, e]));
    let changed = false;
    for (const e of remote) {
      if (e && typeof e.id === 'string' && !byId.has(e.id)) {
        byId.set(e.id, e);
        changed = true;
      }
    }
    if (changed) {
      entries.value = [...byId.values()]
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_ENTRIES);
    }
  }

  async function initActivityStore(): Promise<void> {
    store = await loadKvStore(STORE_PATH);
    entries.value = (await store.get<ActivityEntry[]>('entries')) ?? [];
    usage.value = (await store.get<UsageSample[]>('usage')) ?? [];
    if (typeof window !== 'undefined' && !syncTimer) {
      syncTimer = setInterval(() => void syncEntries(), 5000);
    }
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
