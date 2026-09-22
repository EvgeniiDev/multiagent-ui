// Column + priority vocab for the board. Ids are the persisted `status`
// values in the board store — keep them in sync with BOARD_COLUMN_IDS.
import type { BoardColumnId, BoardPriority } from '../../stores/board';

export interface BoardColumnDef {
  id: BoardColumnId;
  label: string;
}

export const BOARD_COLUMNS: BoardColumnDef[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'ready', label: 'Ready' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'active', label: 'Active' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
];

export function columnLabel(id: BoardColumnId): string {
  return BOARD_COLUMNS.find((c) => c.id === id)?.label ?? id;
}

export const PRIORITIES: { id: BoardPriority; label: string }[] = [
  { id: 'high', label: 'high' },
  { id: 'medium', label: 'medium' },
  { id: 'low', label: 'low' },
];
