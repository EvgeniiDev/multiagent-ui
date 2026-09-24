// Run-state derivation for a board card (pipeline requirements §E / P7):
// the card stores `session {agentName, sessionId}` — the orchestrator —
// and everything else is derived from facts: the live claim in
// claims.json and the activity ledger, never from promises.
import type { ActivityEntry } from '../../stores/activity';
import type { BoardCard } from '../../stores/board';
import type { CardClaim } from '../../stores/claims';

/** идёт = live claim; ждёт = orchestrator attached but no live claim and
 * no terminal ledger record; завершён = the ledger recorded the run's end. */
export type RunState = 'running' | 'waiting' | 'finished';

export interface RunInfo {
  agentName: string;
  sessionId: string;
  state: RunState;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
}

export interface SubagentRow {
  key: string;
  name: string;
  goal: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  outcome: string;
}

// Ledger details that close a run, as the runner and boardctl write them:
// `exit=0`, `claim released`, `lease expired`, `stop-all`/`release-all`,
// `cancel <id>`, `maxRetries N exhausted`.
const TERMINAL_RE =
  /(exit=\d+|claim released|lease expired|stop-all|release-all|maxRetries \d+ exhausted|cancel )/;

/** Ledger rows about this card's run — matched by the run's sessionId
 * when known, else by the card title (the boardctl/runner convention). */
function runEntries(
  card: BoardCard,
  sessionId: string,
  entries: ActivityEntry[]
): ActivityEntry[] {
  return entries.filter((e) =>
    sessionId ? e.sessionId === sessionId : !!e.title && e.title === card.title
  );
}

/**
 * The card's orchestrator run. Returns null when nothing ties a run to the
 * card at all (no claim, no attached session) — an assigned agent alone is
 * an intention, not a run.
 */
export function runInfoFor(
  card: BoardCard,
  claim: CardClaim | null,
  entries: ActivityEntry[],
  now: number
): RunInfo | null {
  if (!claim && !card.session) return null;
  const agentName = claim?.agentName || card.session?.agentName || card.agent || '';
  const sessionId = claim?.sessionId || card.session?.sessionId || '';

  if (claim && Number(claim.leaseUntil) > now) {
    const startedAt = claim.startedAt || claim.claimedAt || null;
    return {
      agentName,
      sessionId,
      state: 'running',
      startedAt,
      endedAt: null,
      durationMs: startedAt ? Math.max(0, now - startedAt) : null,
    };
  }

  const rel = runEntries(card, sessionId, entries);
  const lastTerminal = [...rel].reverse().find((e) => TERMINAL_RE.test(e.detail ?? ''));
  const startedAt = claim?.startedAt || claim?.claimedAt || rel[0]?.at || null;
  if (lastTerminal) {
    return {
      agentName,
      sessionId,
      state: 'finished',
      startedAt,
      endedAt: lastTerminal.at,
      durationMs: startedAt ? Math.max(0, lastTerminal.at - startedAt) : null,
    };
  }

  // A claim past its lease (heartbeat stopped, not yet swept), or a
  // session attached with no ledger evidence of a run yet — the
  // orchestrator is waiting, not running and not finished.
  return {
    agentName,
    sessionId,
    state: 'waiting',
    startedAt,
    endedAt: null,
    durationMs: startedAt ? Math.max(0, now - startedAt) : null,
  };
}

/**
 * Subagent rows for a run: `delegate` ledger entries keyed to the
 * orchestrator's sessionId, grouped per subagent (the `subagent` field, or
 * `title` when absent). Start/finish events correlate into one row whose
 * state is whatever the newest event asserts — a lone start reads
 * "running", a lone finish still produces a row.
 */
export function subagentsFor(
  sessionId: string,
  entries: ActivityEntry[],
  now: number
): SubagentRow[] {
  if (!sessionId) return [];
  const groups = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    if (e.kind !== 'delegate' || e.sessionId !== sessionId) continue;
    const key = e.subagent || e.title || 'subagent';
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const rows: SubagentRow[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.at - b.at);
    const first = list[0];
    const last = list[list.length - 1];
    const state = last.subState ?? 'running';
    const endedAt = last.endedAt ?? (state === 'running' ? null : last.at);
    rows.push({
      key,
      name: last.subagent || last.title || key,
      goal: first.goal || first.detail || '',
      state,
      startedAt: first.at,
      endedAt,
      durationMs: Math.max(0, (endedAt ?? now) - first.at),
      outcome: state === 'running' ? '' : last.detail || '',
    });
  }
  rows.sort((a, b) => a.startedAt - b.startedAt);
  return rows;
}
