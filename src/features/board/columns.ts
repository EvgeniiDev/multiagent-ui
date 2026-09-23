// Stage + status vocab for the board. Stage ids are the persisted `stage`
// values in the board store — keep them in sync with BOARD_STAGE_IDS.
// Status ids are the persisted `status` values — keep them in sync with
// STAGE_STATUSES.
import type { BoardStageId, BoardPriority, CardStatus } from '../../stores/board';
import { STAGE_STATUSES } from '../../stores/board';

export interface BoardStageDef {
  id: BoardStageId;
  label: string;
}

/** Pipeline columns in order: Backlog → Spec → Plan → Dev → Review/Test → Done. */
export const BOARD_STAGES: BoardStageDef[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'dev', label: 'Dev' },
  { id: 'reviewtest', label: 'Review/Test' },
  { id: 'done', label: 'Done' },
];

export function stageLabel(id: BoardStageId): string {
  return BOARD_STAGES.find((c) => c.id === id)?.label ?? id;
}

/** Statuses a card can take inside `stage` — empty for backlog/done. */
export function statusesForStage(stage: BoardStageId): CardStatus[] {
  return STAGE_STATUSES[stage];
}

/** Compact per-status tally for a stage header: `in_progress 1 / review 1`.
 * Only statuses with at least one card are listed; status-less stages and
 * empty stages render ''. */
export function statusBreakdown(
  stage: BoardStageId,
  cards: { status: CardStatus | null }[]
): string {
  const allowed = STAGE_STATUSES[stage];
  if (!allowed.length || !cards.length) return '';
  const parts = allowed
    .map((s) => `${s} ${cards.filter((c) => c.status === s).length}`)
    .filter((p) => !p.endsWith(' 0'));
  return parts.join(' / ');
}

export const PRIORITIES: { id: BoardPriority; label: string }[] = [
  { id: 'high', label: 'high' },
  { id: 'medium', label: 'medium' },
  { id: 'low', label: 'low' },
];
