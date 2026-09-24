// Review-cycle state: the structured findings a reviewer writes into the
// card's artifact dir (`.acp/cards/<id>/review_findings.json`). The panel
// reads them through the fs bridge (the artifacts store feeds this store on
// refresh) and uses them for three things:
//
//   1. the severity counter on the card (critical / major / minor, round);
//   2. the `agent_tested` gate — board.ts asks `gateRefusal` before letting
//      a reviewtest card take `agent_tested`;
//   3. the round-limit flag — when the recorded round reaches the role's
//      `review.maxRounds` with blocking findings still open, the card is
//      flagged `blocked` with a `review:`-prefixed reason.
//
// The review LOOP itself (developer → reviewer → fix) is not here — it
// lives in the role prompt files and the CLI agents' skills; this store
// only mirrors what the findings file says.
//
// Severity vocabulary + limits come from the reviewtest role's `review`
// data (roles.ts) — nothing about them is hard-coded per component.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useBoardStore } from './board';
import { useRolesStore } from './roles';

export const REVIEW_FILE = 'review_findings.json';

/** Marks `blockedReason` values this cycle owns, so applyDerived never
 * touches a human's (or pm's) blocked flag. */
export const REVIEW_REASON_PREFIX = 'review:';

export interface ReviewFinding {
  id: string;
  /** Round this finding was reported in. */
  round: number;
  severity: string;
  /** One-line summary of what is wrong. */
  text: string;
  /** Where it was seen (file:line, artifact section, ...). */
  where: string;
  status: 'open' | 'closed';
  /** Round it was closed in, once closed. */
  closedInRound: number | null;
}

export interface CardReviewState {
  /** Current review round (doc-level `round`, or the max finding round). */
  round: number | null;
  findings: ReviewFinding[];
  /** Parse/bridge error — surfaced in the drawer; `unreadable` additionally
   * means a file exists but could not be parsed, which fails the
   * agent_tested gate closed (cannot verify nothing is open). */
  error: string;
  unreadable: boolean;
  loadedAt: number | null;
}

export function emptyReview(): CardReviewState {
  return { round: null, findings: [], error: '', unreadable: false, loadedAt: null };
}

/** Parse `review_findings.json`. Throws on malformed docs; individual
 * findings that cannot be salvaged (no string `id`) are skipped. */
export function parseReviewDoc(content: string): {
  round: number | null;
  findings: ReviewFinding[];
} {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    throw new Error(`malformed JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('findings doc must be a JSON object');
  }
  const raw = doc as { findings?: unknown; round?: unknown };
  const findings: ReviewFinding[] = [];
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) {
      if (!f || typeof f !== 'object') continue;
      const x = f as Record<string, unknown>;
      if (typeof x.id !== 'string' || !x.id.trim()) continue;
      findings.push({
        id: x.id,
        round: Number.isInteger(x.round) ? (x.round as number) : 0,
        severity: typeof x.severity === 'string' && x.severity ? x.severity : 'unknown',
        text: typeof x.text === 'string' ? x.text : '',
        where: typeof x.where === 'string' ? x.where : '',
        status: x.status === 'closed' ? 'closed' : 'open',
        closedInRound: Number.isInteger(x.closedInRound) ? (x.closedInRound as number) : null,
      });
    }
  }
  let round =
    Number.isInteger(raw.round) && (raw.round as number) >= 1 ? (raw.round as number) : null;
  if (round === null) {
    const max = findings.reduce((m, f) => Math.max(m, f.round), 0);
    round = max || null;
  }
  return { round, findings };
}

export const useReviewStore = defineStore('review', () => {
  /** card id -> latest parsed findings state. */
  const byCard = ref<Record<string, CardReviewState>>({});

  function stateFor(cardId: string): CardReviewState | null {
    return byCard.value[cardId] ?? null;
  }

  /** Store the parsed state and re-derive the card's review-owned flags. */
  function set(cardId: string, st: CardReviewState): void {
    byCard.value[cardId] = st;
    applyDerived(cardId);
  }

  /** Open findings per severity (closed findings never count). */
  function openCounts(cardId: string): Record<string, number> {
    const st = byCard.value[cardId];
    const counts: Record<string, number> = {};
    if (!st || st.error) return counts;
    for (const f of st.findings) {
      if (f.status !== 'open') continue;
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    }
    return counts;
  }

  /** The `agent_tested` gate: refusal text naming severity + count, or null
   * when nothing blocking is open. A findings file that exists but cannot
   * be parsed fails the gate closed — the panel cannot verify there is
   * nothing open. A missing file (or an unreachable bridge) does not
   * block: nothing is known to be open. */
  function gateRefusal(cardId: string): string | null {
    const st = byCard.value[cardId];
    if (st?.unreadable) {
      return `review findings unreadable — cannot verify none are open (${st.error || 'malformed doc'})`;
    }
    const rules = useRolesStore().reviewRulesForStage('reviewtest');
    const counts = openCounts(cardId);
    const parts = rules.blocking
      .map((s) => ({ s, n: counts[s] ?? 0 }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} ${x.s}`);
    return parts.length ? `open review findings — ${parts.join(', ')}` : null;
  }

  /** Round-limit flagging. When the recorded round reaches the role's
   * `maxRounds` with blocking findings still open, the card is flagged
   * `blocked` with a `review:` reason; when the condition stops holding a
   * `review:`-owned mark is cleared again. Foreign reasons are never
   * touched. Idempotent — safe to run on every findings refresh. */
  function applyDerived(cardId: string): void {
    const board = useBoardStore();
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;
    const st = byCard.value[cardId];
    if (!st || st.error) return;
    const rules = useRolesStore().reviewRulesForStage('reviewtest');
    const counts = openCounts(cardId);
    const detail = rules.blocking
      .map((s) => ({ s, n: counts[s] ?? 0 }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} ${x.s}`)
      .join(', ');
    const over = st.round !== null && st.round >= rules.maxRounds && detail.length > 0;
    const reason = `review: round limit ${rules.maxRounds} reached with open findings (${detail})`;
    const reviewOwned = card.blockedReason.startsWith(REVIEW_REASON_PREFIX);
    if (over) {
      if (!card.blocked) {
        board.updateCard(cardId, { blockedReason: reason });
        board.setCardFlag(cardId, 'blocked', true);
      } else if (reviewOwned && card.blockedReason !== reason) {
        board.updateCard(cardId, { blockedReason: reason });
      }
      // card.blocked with a foreign reason: the flag is already on — the
      // human's reason stands.
    } else if (card.blocked && reviewOwned) {
      board.setCardFlag(cardId, 'blocked', false);
      board.updateCard(cardId, { blockedReason: '' });
    }
  }

  return { byCard, stateFor, set, openCounts, gateRefusal, applyDerived };
});
