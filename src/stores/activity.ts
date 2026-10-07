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
//   usageByModel(from, to)         [{ model, provider, tokens, cost, turns }]
//   usageByDay(from, to)           [{ day: 'YYYY-MM-DD', tokens, cost, turns }]
//   dayRange(days)                 helpers: { from, to } for common windows
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { stateServerBase, loadKvStore, type KVStore } from '../lib/host/storage';

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
  | 'pm'
  | 'sync';

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  agentName: string;
  sessionId?: string;
  /** Role the dispatcher ran under, on `card` events it wrote. */
  role?: string;
  /** Model the dispatcher's run/claim used for this step, on `card`
   * events — present only when the role carries `models` (never invented). */
  model?: string;
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

/** Provider-reported usage or an approximate bridge estimate. ACP context
 * occupancy is stored separately via accounting:'context' and is not spend. */
export type UsageSource = 'agent' | 'estimate';
export interface UsageSourceStatus { agentName: string; status: 'ready' | 'partial' | 'unavailable'; samples: number; }

export interface UsageSample {
  at: number;
  agentName: string;
  sessionId: string;
  cwd?: string;
  used: number;
  size: number;
  accounting?: 'cumulative' | 'delta' | 'context';
  timeBasis?: 'session-last-active';
  cost?: number;
  currency?: string;
  source?: UsageSource;
  /** The agent's session model identifier as announced on `session/new` /
   * `session/load` (`models.currentModelId`, or the `model` config option's
   * value), or the OpenCode plugin's `info.modelID`. Written verbatim — the
   * same string the model picker shows. Samples written before this field
   * existed carry none and read as `unknown`. */
  model?: string;
  /** Provider when the writer actually knows it (the plugin's
   * `info.providerID`). `undefined` reads as `unknown` — the panel and the
   * bridge see a model id, never a structured provider field. */
  provider?: string;
}

/** Last path segment of a working directory — the project's display name. */
export function projectName(cwd?: string): string {
  if (!cwd) return 'unknown';
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

function agentLabel(name: string): string {
  const cmd = name.split(/[\\/]/).pop() ?? name;
  return ({ 'pi-acp': 'Pi', pi: 'Pi', 'codex-acp': 'Codex', codex: 'Codex', hermes: 'Hermes Agent', opencode: 'OpenCode', devin: 'Devin' } as Record<string, string>)[cmd] ?? name;
}

const sampleSource = (row: UsageSample): UsageSource => row.source ?? 'agent';
const sampleModel = (row: UsageSample): string => row.model ?? 'unknown';
const sampleProvider = (row: UsageSample): string => row.provider ?? 'unknown';

function sessionKey(row: { agentName: string; sessionId?: string; cwd?: string }): string {
  return `${row.agentName}::${row.sessionId ?? row.cwd ?? ''}`;
}

/**
 * Rows eligible for delta math. The bridge writes a shadow estimate for the
 * sessions it proxies, so a session can carry both layers; when even one
 * agent-reported sample exists for it, only those count — mixing an estimate
 * series with the real running total would double-count the session. A
 * session with no agent rows keeps its estimate rows (Devin, Pi today).
 */
function countableRows(all: UsageSample[]): UsageSample[] {
  const factual = new Set<string>();
  // Older ACP context notifications were incorrectly recorded as spend.
  // OpenCode's plugin is the exception: it records cumulative message usage.
  const spend = all.filter(r => r.accounting !== 'context' && !r.agentName.startsWith('/') &&
    (r.accounting || sampleSource(r) === 'estimate' || !['Hermes Agent', 'Pi', 'Codex'].includes(r.agentName)));
  for (const row of spend) {
    if (sampleSource(row) === 'agent') factual.add(sessionKey(row));
  }
  return spend.filter((r) => sampleSource(r) === 'agent' || !factual.has(sessionKey(r)));
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
  // Ledger rows are immutable facts. Publish snapshots instead of tracking
  // every field of 5000 rows through deep reactive proxies in every card.
  const entries = shallowRef<ActivityEntry[]>([]);
  const usage = ref<UsageSample[]>([]);
  const nativeRows = shallowRef<UsageSample[]>([]);
  const usageSources = ref<UsageSourceStatus[]>([]);
  const usageLoading = ref(false);
  const usageError = ref('');
  const allUsage = computed(() => {
    const covered = new Set(usageSources.value.filter(s => s.status !== 'unavailable').map(s => s.agentName));
    const legacy = usage.value.map(r => ({ ...r, agentName: agentLabel(r.agentName) }));
    return [...legacy.filter(r => !covered.has(r.agentName)), ...nativeRows.value];
  });
  let nativeRequest: Promise<void> | null = null;
  async function refreshNativeUsage(): Promise<void> {
    if (nativeRequest) return nativeRequest;
    usageLoading.value = true;
    nativeRequest = (async () => {
      try {
        const response = await fetch(`${stateServerBase()}/api/usage`, { signal: AbortSignal.timeout(65000) });
        if (!response.ok) throw new Error(`Usage data unavailable (HTTP ${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data.usage) || !Array.isArray(data.sources)) throw new Error('Invalid usage data');
        nativeRows.value = data.usage;
        usageSources.value = data.sources;
        usageError.value = '';
      } catch (e) {
        usageError.value = e instanceof Error ? e.message : 'Usage data unavailable';
      } finally { usageLoading.value = false; nativeRequest = null; }
    })();
    return nativeRequest;
  }
  let store: KVStore | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  // Shared index is rebuilt only when the ledger snapshot changes.
  const runEntriesIndex = computed(() => {
    const sessions = new Map<string, ActivityEntry[]>();
    const titles = new Map<string, ActivityEntry[]>();
    for (const entry of entries.value) {
      const sessionId = entry.sessionId;
      if (sessionId) {
        const bucket = sessions.get(sessionId) ?? [];
        bucket.push(entry);
        sessions.set(sessionId, bucket);
      }
      if (entry.title) {
        const bucket = titles.get(entry.title) ?? [];
        bucket.push(entry);
        titles.set(entry.title, bucket);
      }
    }
    return { sessions, titles };
  });
  function entriesForRun(sessionId: string, title: string): ActivityEntry[] {
    return (sessionId
      ? runEntriesIndex.value.sessions.get(sessionId)
      : runEntriesIndex.value.titles.get(title)) ?? [];
  }

  const recent = (limit = 50): ActivityEntry[] => entries.value.slice(-limit).reverse();

  function entriesInRange(from: number, to: number): ActivityEntry[] {
    return entries.value.filter((e) => e.at >= from && e.at <= to);
  }

  function usageInRange(from: number, to: number): UsageSample[] {
    return allUsage.value.filter((u) => u.at >= from && u.at <= to);
  }

  /** One delta per recorded call, retaining its model and currency. Native
   * records are already deltas; legacy running counters are differenced. */
  function deltaRows(from: number, to: number) {
    const previous = new Map<string, UsageSample>();
    const out: Array<{ at: number; agentName: string; cwd?: string; sessionId: string;
      model: string; provider: string; tokens: number; cost?: number; currency?: string; source: UsageSource }> = [];
    for (const row of [...countableRows(allUsage.value)].sort((a, b) => a.at - b.at)) {
      if (row.at > to) continue;
      const key = sessionKey(row);
      const before = previous.get(key);
      const value = Math.max(0, Number.isFinite(row.used) ? row.used : 0);
      const delta = row.accounting === 'delta' ? value
        : value >= (before?.used ?? 0) ? value - (before?.used ?? 0) : value;
      let cost: number | undefined;
      if (typeof row.cost === 'number' && Number.isFinite(row.cost)) {
        const base = before?.currency === row.currency ? before?.cost ?? 0 : 0;
        cost = row.accounting === 'delta' ? row.cost : row.cost >= base ? row.cost - base : row.cost;
      }
      if (row.accounting !== 'delta') previous.set(key, { ...row, cost: row.cost ?? before?.cost });
      if (row.at < from) continue;
      out.push({ at: row.at, agentName: row.agentName, cwd: row.cwd, sessionId: row.sessionId,
        model: sampleModel(row), provider: sampleProvider(row), tokens: delta, cost,
        currency: row.currency, source: sampleSource(row) });
    }
    return out;
  }

  function consumedInRange(from: number, to: number) {
    const rows = deltaRows(from, to);
    return { tokens: rows.reduce((n, r) => n + r.tokens, 0),
      estTokens: rows.reduce((n, r) => n + (r.source === 'estimate' ? r.tokens : 0), 0),
      cost: rows.reduce((n, r) => n + (r.cost ?? 0), 0),
      sessions: new Set(rows.map(sessionKey)).size };
  }

  function consumedByDay(from: number, to: number) {
    const out = new Map<string, { tokens: number; estTokens: number; cost: number }>();
    for (const row of deltaRows(from, to)) {
      const day = new Date(row.at).toISOString().slice(0, 10);
      const acc = out.get(day) ?? { tokens: 0, estTokens: 0, cost: 0 };
      acc.tokens += row.tokens;
      if (row.source === 'estimate') acc.estTokens += row.tokens;
      acc.cost += row.cost ?? 0;
      out.set(day, acc);
    }
    return out;
  }

  function totalUsage(from: number, to: number): { tokens: number; estTokens: number; cost: number; turns: number } {
    const { tokens, estTokens, cost } = consumedInRange(from, to);
    const turns = entriesInRange(from, to).filter((e) => e.kind === 'turn-end').length;
    return { tokens, estTokens, cost, turns };
  }

  /** Cost is reported in the agent's own currency; mixed currencies stay separate. */
  function usageByAgent(from: number, to: number) {
    const map = new Map<string, { agentName: string; tokens: number; estTokens: number; cost: number; turns: number }>();
    for (const source of usageSources.value) {
      if (source.status !== 'unavailable') map.set(source.agentName,
        { agentName: source.agentName, tokens: 0, estTokens: 0, cost: 0, turns: 0 });
    }
    for (const row of deltaRows(from, to)) {
      const acc = map.get(row.agentName) ?? { agentName: row.agentName, tokens: 0, estTokens: 0, cost: 0, turns: 0 };
      acc.tokens += row.tokens;
      if (row.source === 'estimate') acc.estTokens += row.tokens;
      acc.cost += row.cost ?? 0;
      map.set(row.agentName, acc);
    }
    const turns = turnsBy(from, to, (e) => e.agentName);
    for (const [key, value] of turns) {
      const acc = map.get(key) ?? { agentName: key, tokens: 0, estTokens: 0, cost: 0, turns: 0 };
      acc.turns = value;
      map.set(key, acc);
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  /**
   * Spend grouped by session model. The model lives on usage samples, not on
   * entries, so turns reach it through a sessionId -> model map built from the
   * same delta rows (a turn-end whose session left no countable sample falls
   * back to `unknown`).
   */
  function usageByModel(from: number, to: number) {
    const map = new Map<string, { model: string; provider: string; tokens: number; estTokens: number; cost: number; turns: number }>();
    const sessionModel = new Map<string, string>();
    for (const row of deltaRows(from, to)) {
      const key = `${row.provider}::${row.model}`;
      const acc = map.get(key) ?? { model: row.model, provider: row.provider, tokens: 0, estTokens: 0, cost: 0, turns: 0 };
      acc.tokens += row.tokens;
      if (row.source === 'estimate') acc.estTokens += row.tokens;
      acc.cost += row.cost ?? 0;
      if (acc.provider === 'unknown' && row.provider !== 'unknown') acc.provider = row.provider;
      map.set(key, acc);
      if (row.sessionId) sessionModel.set(sessionKey(row), key);
    }
    const turns = turnsBy(from, to, (e) => (e.sessionId ? sessionModel.get(`${e.agentName}::${e.sessionId}`) ?? 'unknown' : 'unknown'));
    for (const [key, value] of turns) {
      const acc = map.get(key) ?? { model: key, provider: 'unknown', tokens: 0, estTokens: 0, cost: 0, turns: 0 };
      acc.turns = value;
      map.set(key, acc);
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  function usageByProject(from: number, to: number) {
    const map = new Map<string, { project: string; cwd?: string; tokens: number; estTokens: number; cost: number; turns: number }>();
    for (const row of deltaRows(from, to)) {
      const project = projectName(row.cwd);
      const acc = map.get(project) ?? { project, cwd: row.cwd, tokens: 0, estTokens: 0, cost: 0, turns: 0 };
      acc.tokens += row.tokens;
      if (row.source === 'estimate') acc.estTokens += row.tokens;
      acc.cost += row.cost ?? 0;
      map.set(project, acc);
    }
    const turns = turnsBy(from, to, (e) => projectName(e.cwd));
    for (const [key, value] of turns) {
      const acc = map.get(key) ?? { project: key, tokens: 0, estTokens: 0, cost: 0, turns: 0 };
      acc.turns = value;
      map.set(key, acc);
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  function usageByDay(from: number, to: number) {
    const map = new Map<string, { day: string; tokens: number; estTokens: number; cost: number; turns: number }>();
    for (const [day, consumed] of consumedByDay(from, to)) {
      map.set(day, { day, tokens: consumed.tokens, estTokens: consumed.estTokens, cost: consumed.cost, turns: 0 });
    }
    for (const entry of entriesInRange(from, to)) {
      if (entry.kind !== 'turn-end') continue;
      const day = new Date(entry.at).toISOString().slice(0, 10);
      const acc = map.get(day) ?? { day, tokens: 0, estTokens: 0, cost: 0, turns: 0 };
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
    entries.value = [...entries.value.slice(-(MAX_ENTRIES - 1)), { id: nextId(), at: entry.at ?? Date.now(), ...entry }];
    scheduleSave();
  }

  function recordUsage(sample: Omit<UsageSample, 'at'> & { at?: number }): void {
    // `usage_update` arrives per turn; keeping the last one per session window
    // avoids summing the same running total over and over.
    const at = sample.at ?? Date.now();
    const last = [...usage.value].reverse().find((u) => u.sessionId === sample.sessionId && u.agentName === sample.agentName);
    // Skip a sample that repeats the previous one for this session: the agents
    // report a running total, so an unchanged used/size/cost adds nothing. The
    // source matters too — an estimate may legitimately match an agent row.
    const sameCost =
      (sample.cost ?? null) === (last?.cost ?? null) &&
      (sample.currency ?? null) === (last?.currency ?? null);
    const sameSource = (sample.source ?? 'agent') === (last?.source ?? 'agent');
    // A mid-session model switch is real information: identical totals under a
    // different announced model still earn a new sample.
    const sameModel =
      (sample.model ?? 'unknown') === (last?.model ?? 'unknown') &&
      (sample.provider ?? 'unknown') === (last?.provider ?? 'unknown');
    if (last && sample.used === last.used && sample.size === last.size && sameCost && sameSource && sameModel) {
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
  // rows that haven't been pushed yet. The same holds for `usage`: the
  // ws-bridge estimator and the opencode plugin append samples straight to
  // the doc, so usage rows merge on their identity tuple (no `id` field).
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

    const remoteUsage = (await store.get<UsageSample[]>('usage')) ?? [];
    const usageKey = (u: UsageSample) =>
      `${u.agentName}|${u.sessionId}|${u.at}|${u.used}|${u.size}|${u.cost ?? ''}|${u.source ?? ''}|${u.model ?? ''}|${u.provider ?? ''}`;
    const byKey = new Map(usage.value.map((u) => [usageKey(u), u]));
    let usageChanged = false;
    for (const u of remoteUsage) {
      if (u && typeof u.at === 'number' && typeof u.used === 'number' && !byKey.has(usageKey(u))) {
        byKey.set(usageKey(u), u);
        usageChanged = true;
      }
    }
    if (usageChanged) {
      usage.value = [...byKey.values()]
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_USAGE);
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
    usageSources,
    usageLoading,
    usageError,
    refreshNativeUsage,
    recent,
    entriesInRange,
    entriesForRun,
    usageInRange,
    deltaRows,
    totalUsage,
    usageByAgent,
    usageByModel,
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
