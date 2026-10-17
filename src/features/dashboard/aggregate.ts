import { priceUsage } from './pricing';
import { projectName, type ActivityEntry, type UsageSourceStatus, type UsageSource } from '../../stores/activity';

export interface SpendRow {
  at: number; agentName: string; sessionId: string; cwd?: string;
  model: string; provider: string; tokens: number; cost?: number; currency?: string; source: UsageSource;
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
}
export interface UsageGroup {
  key: string; name: string; detail: string; tokens: number; estTokens: number;
  /** Token mix reported by providers; `input` excludes cached reads/writes. */
  input: number; output: number; cacheRead: number; cacheWrite: number;
  costs: Array<{ currency: string; amount: number }>; turns: number; lastAt: number;
  agentName?: string; sessionId?: string; cwd?: string; model?: string; provider?: string; day?: string;
}
interface Accumulator extends Omit<UsageGroup, 'costs'> { money: Map<string, number>; }
export function localDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function bucket(key: string, name: string, detail = ''): Accumulator {
  return { key, name, detail, tokens: 0, estTokens: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, money: new Map(), turns: 0, lastAt: 0 };
}
function add(acc: Accumulator, row: SpendRow): void {
  acc.tokens += row.tokens;
  acc.input += row.input ?? 0;
  acc.output += row.output ?? 0;
  acc.cacheRead += row.cacheRead ?? 0;
  acc.cacheWrite += row.cacheWrite ?? 0;
  if (row.source === 'estimate') acc.estTokens += row.tokens;
  acc.lastAt = Math.max(acc.lastAt, row.at);
  if (typeof row.cost === 'number' && Number.isFinite(row.cost)) {
    const currency = row.currency ?? '';
    acc.money.set(currency, (acc.money.get(currency) ?? 0) + row.cost);
  }
}
function finish(acc: Accumulator): UsageGroup {
  const { money, ...group } = acc;
  return { ...group, costs: [...money].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount) };
}

/** Delta math stays in the activity store. Index these immutable deltas once,
 * rather than scanning the history separately for every table row. */
export function aggregateUsage(rows: SpendRow[], entries: ActivityEntry[], sources: UsageSourceStatus[] = []) {
  const maps = { models: new Map<string, Accumulator>(), projects: new Map<string, Accumulator>(),
    agents: new Map<string, Accumulator>(), sessions: new Map<string, Accumulator>(), days: new Map<string, Accumulator>() };
  const total = bucket('total', 'Total');
  let hasMissingCosts = false;
  const sessionModels = new Map<string, string>();
  for (const source of sources) {
    if (source.status !== 'unavailable') maps.agents.set(source.agentName, bucket(source.agentName, source.agentName, source.status));
  }
  const get = (map: Map<string, Accumulator>, key: string, name: string, detail = '') => {
    const value = map.get(key) ?? bucket(key, name, detail); map.set(key, value); return value;
  };
  for (const rawRow of rows) {
    const row = priceUsage(rawRow);
    if (typeof row.cost !== 'number' || !Number.isFinite(row.cost)) hasMissingCosts = true;
    const sessionKey = `${row.agentName}::${row.sessionId}`;
    const modelKey = `${row.provider}::${row.model}`;
    const project = projectName(row.cwd);
    const day = localDayKey(row.at);
    add(total, row);
    const model = get(maps.models, modelKey, row.model, row.provider);
    model.model = row.model; model.provider = row.provider; add(model, row);
    const proj = get(maps.projects, project, project, 'Project');
    proj.cwd ??= row.cwd; add(proj, row);
    const agent = get(maps.agents, row.agentName, row.agentName, 'Reported');
    agent.agentName = row.agentName; add(agent, row);
    const session = get(maps.sessions, sessionKey, row.sessionId.slice(0, 8), `${row.agentName} · ${project}`);
    if (row.at >= session.lastAt) { session.cwd = row.cwd; session.detail = `${row.agentName} · ${project}`; }
    session.agentName = row.agentName; session.sessionId = row.sessionId; add(session, row);
    const daily = get(maps.days, day, day); daily.day = day; add(daily, row);
    sessionModels.set(sessionKey, modelKey);
  }
  let toolCalls = 0;
  const titleAt = new Map<string, number>();
  for (const entry of entries) {
    const sessionKey = `${entry.agentName}::${entry.sessionId}`;
    const session = maps.sessions.get(sessionKey);
    if (session && entry.title && entry.at >= (titleAt.get(sessionKey) ?? 0)) {
      session.name = entry.title; titleAt.set(sessionKey, entry.at);
    }
    if (entry.kind === 'tool-call') toolCalls++;
    if (entry.kind !== 'turn-end') continue;
    total.turns++;
    get(maps.agents, entry.agentName, entry.agentName, 'Activity log').turns++;
    get(maps.projects, projectName(entry.cwd), projectName(entry.cwd), 'Project').turns++;
    const key = sessionModels.get(sessionKey) ?? 'unknown::unknown';
    get(maps.models, key, 'unknown', 'unknown').turns++;
    const day = localDayKey(entry.at);
    const daily = get(maps.days, day, day); daily.day = day; daily.turns++;
    if (session) session.turns++;
  }
  const ranked = (map: Map<string, Accumulator>) => [...map.values()].map(finish).sort((a, b) => b.tokens - a.tokens);
  return { total: { ...finish(total), hasMissingCosts, sessions: maps.sessions.size, toolCalls },
    models: ranked(maps.models), projects: ranked(maps.projects), agents: ranked(maps.agents),
    sessions: ranked(maps.sessions), days: [...maps.days.values()].map(finish).sort((a, b) => a.key.localeCompare(b.key)) };
}
