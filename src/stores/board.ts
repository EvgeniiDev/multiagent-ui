// Board store: the kanban's local-first card collection (F3).
//
// Cards live in `board.json` (keys `version` + `cards`) via the host KV
// abstraction — localStorage on web, plugin-store on Tauri — and are
// persisted debounced on every mutation, so a reload restores the board.
//
// Card lifecycle (create / move / duplicate / delete) is mirrored into the
// activity ledger as `sync` entries so Board → Events shows card status
// changes next to agent events (F4). The ActivityKind union has no
// card-specific kind and `activity.ts` is owned by the ledger workstream,
// so `sync` is the honest fit: it already means "client-side state changed".
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { uuid } from '../lib/uuid';
import { useActivityStore } from './activity';

export type BoardColumnId =
  | 'inbox'
  | 'ready'
  | 'blocked'
  | 'active'
  | 'review'
  | 'done'
  | 'cancelled';

export type BoardPriority = 'high' | 'medium' | 'low';

export interface BoardLink {
  label: string;
  url: string;
}

export interface BoardCardSession {
  agentName: string;
  sessionId: string;
}

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  /** Free-text project label; defaults to the last path segment of a cwd. */
  project: string;
  /** Assigned agent name (from the config store), or '' for unassigned. */
  agent: string;
  priority: BoardPriority;
  acceptance: string;
  verification: string;
  links: BoardLink[];
  session: BoardCardSession | null;
  /** Free-text "blocked by" note; counts toward the blocked column's marker. */
  blockedBy: string;
  status: BoardColumnId;
  /** Ordering key inside a column; renormalized on moves. */
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardFilters {
  project: string;
  agent: string;
  priority: '' | BoardPriority;
  search: string;
}

export const BOARD_COLUMN_IDS: BoardColumnId[] = [
  'inbox',
  'ready',
  'blocked',
  'active',
  'review',
  'done',
  'cancelled',
];

const STORE_PATH = 'board.json';
const STORE_VERSION = 1;
const ORDER_STEP = 10;

function emptyFilters(): BoardFilters {
  return { project: '', agent: '', priority: '', search: '' };
}

/** Restore a persisted card, coercing anything malformed into a safe shape. */
function sanitizeCard(raw: unknown): BoardCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<BoardCard>;
  if (typeof c.id !== 'string' || typeof c.title !== 'string') return null;
  const status = BOARD_COLUMN_IDS.includes(c.status as BoardColumnId)
    ? (c.status as BoardColumnId)
    : 'inbox';
  const priority: BoardPriority =
    c.priority === 'high' || c.priority === 'medium' || c.priority === 'low'
      ? c.priority
      : 'medium';
  return {
    id: c.id,
    title: c.title,
    description: typeof c.description === 'string' ? c.description : '',
    project: typeof c.project === 'string' ? c.project : '',
    agent: typeof c.agent === 'string' ? c.agent : '',
    priority,
    acceptance: typeof c.acceptance === 'string' ? c.acceptance : '',
    verification: typeof c.verification === 'string' ? c.verification : '',
    links: Array.isArray(c.links)
      ? c.links
          .filter(
            (l): l is BoardLink =>
              !!l && typeof l === 'object' && typeof (l as BoardLink).url === 'string'
          )
          .map((l) => ({ label: String(l.label ?? ''), url: l.url }))
      : [],
    session:
      c.session && typeof c.session === 'object' && typeof c.session.sessionId === 'string'
        ? { agentName: String(c.session.agentName ?? ''), sessionId: c.session.sessionId }
        : null,
    blockedBy: typeof c.blockedBy === 'string' ? c.blockedBy : '',
    status,
    order: typeof c.order === 'number' ? c.order : 0,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
  };
}

export const useBoardStore = defineStore('board', () => {
  const cards = ref<BoardCard[]>([]);
  const filters = ref<BoardFilters>(emptyFilters());
  const ready = ref(false);
  let store: KVStore | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- persistence --------------------------------------------------------

  function scheduleSave(): void {
    if (!store || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 600);
  }

  async function persist(): Promise<void> {
    if (!store) return;
    await store.set('version', STORE_VERSION);
    await store.set('cards', cards.value);
    await store.save();
  }

  async function initBoardStore(): Promise<void> {
    if (ready.value) return;
    store = await loadKvStore(STORE_PATH);
    const version = await store.get<number>('version');
    // Version is informational for now: v1 is the only schema, and
    // `sanitizeCard` already drops anything that doesn't fit it.
    void version;
    const saved = await store.get<unknown[]>('cards');
    if (Array.isArray(saved)) {
      cards.value = saved
        .map(sanitizeCard)
        .filter((c): c is BoardCard => c !== null);
    }
    ready.value = true;

    // Flush a pending debounced write on unload — otherwise a card edited
    // <600ms before a reload would be lost.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          void persist();
        }
      });
    }
  }

  // ---- ledger mirror ------------------------------------------------------

  function logCardEvent(card: BoardCard, detail: string): void {
    useActivityStore().recordEntry({
      kind: 'sync',
      agentName: card.agent || 'board',
      title: card.title,
      detail,
    });
  }

  // ---- queries ------------------------------------------------------------

  function matchesFilters(card: BoardCard): boolean {
    const f = filters.value;
    if (f.project && card.project !== f.project) return false;
    if (f.agent && card.agent !== f.agent) return false;
    if (f.priority && card.priority !== f.priority) return false;
    if (f.search) {
      const q = f.search.trim().toLowerCase();
      const hay = `${card.title} ${card.description} ${card.project} ${card.agent}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const filteredCards = computed(() => cards.value.filter(matchesFilters));

  const isFiltering = computed(
    () =>
      !!filters.value.project ||
      !!filters.value.agent ||
      !!filters.value.priority ||
      !!filters.value.search.trim()
  );

  /** Filtered, ordered cards of one column — drives both the column body and
   * its header count so the counters always reflect the active filter. */
  function cardsInColumn(col: BoardColumnId): BoardCard[] {
    return filteredCards.value
      .filter((c) => c.status === col)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  const projectOptions = computed(() =>
    [...new Set(cards.value.map((c) => c.project).filter(Boolean))].sort()
  );

  // ---- mutations ----------------------------------------------------------

  function nextOrder(col: BoardColumnId): number {
    const inCol = cards.value.filter((c) => c.status === col);
    return inCol.length ? Math.max(...inCol.map((c) => c.order)) + ORDER_STEP : ORDER_STEP;
  }

  function makeCard(partial: Partial<BoardCard> = {}): BoardCard {
    const now = Date.now();
    const status = partial.status && BOARD_COLUMN_IDS.includes(partial.status)
      ? partial.status
      : 'inbox';
    return {
      id: uuid(),
      title: partial.title ?? '',
      description: partial.description ?? '',
      project: partial.project ?? '',
      agent: partial.agent ?? '',
      priority: partial.priority ?? 'medium',
      acceptance: partial.acceptance ?? '',
      verification: partial.verification ?? '',
      links: partial.links ? partial.links.map((l) => ({ ...l })) : [],
      session: partial.session ? { ...partial.session } : null,
      blockedBy: partial.blockedBy ?? '',
      status,
      order: partial.order ?? nextOrder(status),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** New cards always land in `inbox` (triage column), per the board spec. */
  function addCard(partial: Partial<BoardCard> = {}): BoardCard {
    const card = makeCard({ ...partial, status: 'inbox' });
    cards.value.push(card);
    scheduleSave();
    logCardEvent(card, 'card created in inbox');
    return card;
  }

  function addExampleCard(): BoardCard {
    const card = makeCard({
      title: 'Example card — safe to edit or delete',
      description:
        'Example card. Fill title, project, agent and priority, then move it between columns.',
      project: 'example',
      priority: 'medium',
      acceptance: '- The card moves between columns\n- It survives a reload',
      verification: '- npm run build:web\n- open the Board view',
      status: 'inbox',
    });
    cards.value.push(card);
    scheduleSave();
    logCardEvent(card, 'example card created');
    return card;
  }

  function updateCard(id: string, patch: Partial<BoardCard>): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return;
    Object.assign(card, patch, { id: card.id, updatedAt: Date.now() });
    scheduleSave();
  }

  function removeCard(id: string): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return;
    cards.value = cards.value.filter((c) => c.id !== id);
    scheduleSave();
    logCardEvent(card, `card deleted from ${card.status}`);
  }

  function duplicateCard(id: string): BoardCard | null {
    const src = cards.value.find((c) => c.id === id);
    if (!src) return null;
    const copy = makeCard({
      ...src,
      title: `${src.title} (copy)`,
      status: src.status,
      order: src.order + 1,
    });
    cards.value.push(copy);
    normalizeColumn(src.status);
    scheduleSave();
    logCardEvent(copy, `duplicated from "${src.title}" in ${src.status}`);
    return copy;
  }

  /** Rewrite a column's order keys to a clean 10, 20, 30… sequence. */
  function normalizeColumn(col: BoardColumnId): void {
    const inCol = cards.value
      .filter((c) => c.status === col)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    inCol.forEach((c, i) => {
      c.order = (i + 1) * ORDER_STEP;
    });
  }

  /**
   * Move a card to `to` column, optionally before `beforeId` (a card already
   * in that column). Same-column calls reorder instead of moving.
   */
  function moveCard(id: string, to: BoardColumnId, beforeId?: string | null): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card || !BOARD_COLUMN_IDS.includes(to)) return;
    const from = card.status;
    card.status = to;
    card.updatedAt = Date.now();

    const siblings = cards.value
      .filter((c) => c.status === to && c.id !== id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const beforeIdx = beforeId ? siblings.findIndex((c) => c.id === beforeId) : -1;
    if (beforeIdx === -1) {
      card.order = siblings.length ? siblings[siblings.length - 1].order + ORDER_STEP : ORDER_STEP;
    } else {
      // Temporarily park halfway, then renormalize the whole column.
      const prev = beforeIdx > 0 ? siblings[beforeIdx - 1].order : 0;
      card.order = (prev + siblings[beforeIdx].order) / 2;
      normalizeColumn(to);
    }
    scheduleSave();
    if (from !== to) logCardEvent(card, `card moved ${from} → ${to}`);
  }

  /** Keyboard path: shift a card one column left/right in BOARD_COLUMN_IDS. */
  function moveCardBy(id: string, delta: -1 | 1): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return;
    const idx = BOARD_COLUMN_IDS.indexOf(card.status);
    const next = BOARD_COLUMN_IDS[idx + delta];
    if (next) moveCard(id, next);
  }

  function clearFilters(): void {
    filters.value = emptyFilters();
  }

  return {
    cards,
    filters,
    ready,
    filteredCards,
    isFiltering,
    projectOptions,
    cardsInColumn,
    initBoardStore,
    addCard,
    addExampleCard,
    updateCard,
    removeCard,
    duplicateCard,
    moveCard,
    moveCardBy,
    clearFilters,
  };
});
