// Board store: the kanban pipeline's local-first card collection (F3, v2 §C).
//
// Cards live in `board.json` (keys `version` + `cards`) via the host KV
// abstraction — localStorage on web, plugin-store on Tauri — and are
// persisted debounced on every mutation, so a reload restores the board.
//
// Model (control-center-v2-requirements §C/§E/§F):
//  - `stage` is the column: backlog → spec → plan → dev → reviewtest → done.
//  - `status` is the card's state *inside* its stage: spec/plan/dev carry
//    `in_progress | review | done`, reviewtest carries
//    `in_progress | agent_tested | accepted`, backlog/done carry `null`.
//  - `blocked` (+ optional `blockedReason`) and `cancelled` are card flags,
//    not columns — they can sit on a card in any stage and keep it out of
//    any future auto-pickup (role/dispatcher groundwork).
//  - `touches` / `dependsOn` / `blocks` / `conflictsWith` are the F10.3
//    fields the future `pm` role needs; the model carries them now, the
//    pm logic lands with the roles workstream.
//  - v1 boards (the old seven-column schema) migrate on load; nothing is
//    lost — `cancelled` cards land in `done` flagged, `blocked` cards land
//    in `backlog` flagged.
//
// Card lifecycle (create / move / status / flag / delete) is mirrored into
// the activity ledger as `card` entries so Board → Events shows card state
// changes next to agent events (F4).
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { uuid } from '../lib/uuid';
import { useActivityStore } from './activity';
import { useUiStore } from './ui';
import { useProjectsStore } from '../features/scope/registry';
import { useReviewStore } from './review';

/** Column of the pipeline. Persisted on the card as `stage`. */
export type BoardStageId =
  | 'backlog'
  | 'spec'
  | 'plan'
  | 'dev'
  | 'reviewtest'
  | 'done';

/** Status inside a stage. Persisted on the card as `status` (null in the
 * status-less backlog/done stages). */
export type CardStatus =
  | 'in_progress'
  | 'review'
  | 'done'
  | 'agent_tested'
  | 'accepted';

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
  /** Free-text project label; matched to the registry by project name or by
   * the project path's last segment. Empty means unassigned. */
  project: string;
  /** Assigned agent name (from the config store), or '' for unassigned. */
  agent: string;
  priority: BoardPriority;
  acceptance: string;
  verification: string;
  links: BoardLink[];
  session: BoardCardSession | null;
  /** Card flags (v2 §F.1): visual marks, not columns. A flagged card is
   * excluded from auto-pickup once the dispatcher lands. */
  blocked: boolean;
  /** Optional reason (free text; may name/link the blocking card). */
  blockedReason: string;
  cancelled: boolean;
  /** F10.3 pm-role fields — model only, no logic yet. */
  touches: string[];
  dependsOn: string[];
  blocks: string[];
  conflictsWith: string[];
  stage: BoardStageId;
  /** Status inside `stage`; null for the status-less backlog/done. */
  status: CardStatus | null;
  /** Last status the card held in each stage it visited — on a move back to
   * a stage the card resumes the status it left there ("если у карточки не
   * было статуса этой стадии" — only a first visit gets the initial). */
  statusByStage: Partial<Record<BoardStageId, CardStatus>>;
  /** Ordering key inside a stage; renormalized on moves. */
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

export const BOARD_STAGE_IDS: BoardStageId[] = [
  'backlog',
  'spec',
  'plan',
  'dev',
  'reviewtest',
  'done',
];

/** Statuses valid inside each stage, in workflow order. The first entry is
 * the stage's initial status; empty means the stage is status-less. */
export const STAGE_STATUSES: Record<BoardStageId, CardStatus[]> = {
  backlog: [],
  spec: ['in_progress', 'review', 'done'],
  plan: ['in_progress', 'review', 'done'],
  dev: ['in_progress', 'review', 'done'],
  reviewtest: ['in_progress', 'agent_tested', 'accepted'],
  done: [],
};

/** The status a card starts with when it enters a stage. */
export function initialStatusFor(stage: BoardStageId): CardStatus | null {
  return STAGE_STATUSES[stage][0] ?? null;
}

/** Result of a status mutation: `ok: false` with a human-readable `reason`
 * when the review-cycle gate refused the change. */
export interface MutationResult {
  ok: boolean;
  reason?: string;
}

const STORE_PATH = 'board.json';
const STORE_VERSION = 2;
const ORDER_STEP = 10;

/** v1 column → v2 {stage, status, flags}. Old `blocked`/`cancelled` columns
 * become flags on the card (§E); every other column maps to a stage and its
 * initial status. */
const LEGACY_STAGE_MAP: Record<
  string,
  { stage: BoardStageId; status: CardStatus | null; blocked?: boolean; cancelled?: boolean }
> = {
  inbox: { stage: 'backlog', status: null },
  ready: { stage: 'spec', status: 'in_progress' },
  blocked: { stage: 'backlog', status: null, blocked: true },
  active: { stage: 'dev', status: 'in_progress' },
  review: { stage: 'reviewtest', status: 'in_progress' },
  done: { stage: 'done', status: null },
  cancelled: { stage: 'done', status: null, cancelled: true },
};

function emptyFilters(): BoardFilters {
  return { project: '', agent: '', priority: '', search: '' };
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** Coerce `status` into something valid for `stage`: keep it when the stage
 * allows it, otherwise fall back to the stage's initial status. */
function coerceStatus(stage: BoardStageId, raw: unknown): CardStatus | null {
  const allowed = STAGE_STATUSES[stage];
  return allowed.includes(raw as CardStatus)
    ? (raw as CardStatus)
    : initialStatusFor(stage);
}

/** The review-cycle gate (workstream decision): a card in `reviewtest`
 * must not take `agent_tested` while a blocking-severity finding is open.
 * The findings live in the card's artifact dir and are mirrored into the
 * review store by the artifacts loader; `prevStatus` guards so a card
 * already sitting at `agent_tested` is not re-gated by unrelated edits.
 * `boardctl` enforces the same rule reading the findings file directly. */
function reviewGateRefusal(
  cardId: string,
  stage: BoardStageId,
  status: CardStatus,
  prevStatus: CardStatus | null
): string | null {
  if (stage !== 'reviewtest' || status !== 'agent_tested') return null;
  if (prevStatus === 'agent_tested') return null;
  return useReviewStore().gateRefusal(cardId);
}

/** Restore a persisted card, coercing anything malformed into a safe shape.
 * Handles both the v2 shape (`stage` + inner `status` + flags) and the v1
 * shape (`status` = old column id, `blockedBy` note) — the version key is
 * informational; the card's own fields decide which schema it is. */
function sanitizeCard(raw: unknown): BoardCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<BoardCard> & { blockedBy?: unknown };
  if (typeof c.id !== 'string' || typeof c.title !== 'string') return null;

  let stage: BoardStageId;
  let status: CardStatus | null;
  let legacyBlocked = false;
  let legacyCancelled = false;
  const isLegacy =
    !(typeof c.stage === 'string' && BOARD_STAGE_IDS.includes(c.stage as BoardStageId));
  if (!isLegacy) {
    stage = c.stage as BoardStageId;
    status = coerceStatus(stage, c.status);
  } else {
    const legacy = typeof c.status === 'string' ? LEGACY_STAGE_MAP[c.status] : undefined;
    stage = legacy?.stage ?? 'backlog';
    status = legacy ? legacy.status : null;
    legacyBlocked = legacy?.blocked === true;
    legacyCancelled = legacy?.cancelled === true;
  }

  const priority: BoardPriority =
    c.priority === 'high' || c.priority === 'medium' || c.priority === 'low'
      ? c.priority
      : 'medium';
  // v1 called the reason field `blockedBy`; on the old board a non-empty
  // note already meant "marked as blocked", so it upgrades to the flag.
  // Under v2 the flag itself is authoritative — a stale reason text does
  // not re-flag a card the user unblocked.
  const reason =
    typeof c.blockedReason === 'string'
      ? c.blockedReason
      : typeof c.blockedBy === 'string'
        ? c.blockedBy
        : '';
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
    blocked: c.blocked === true || legacyBlocked || (isLegacy && reason.trim().length > 0),
    blockedReason: reason,
    cancelled: c.cancelled === true || legacyCancelled,
    touches: strList(c.touches),
    dependsOn: strList(c.dependsOn),
    blocks: strList(c.blocks),
    conflictsWith: strList(c.conflictsWith),
    stage,
    status,
    statusByStage:
      c.statusByStage && typeof c.statusByStage === 'object'
        ? Object.fromEntries(
            Object.entries(c.statusByStage).filter(
              ([st, s]) =>
                BOARD_STAGE_IDS.includes(st as BoardStageId) &&
                STAGE_STATUSES[st as BoardStageId].includes(s as CardStatus)
            )
          ) as Partial<Record<BoardStageId, CardStatus>>
        : {},
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
    const saved = await store.get<unknown[]>('cards');
    if (Array.isArray(saved)) {
      cards.value = saved
        .map(sanitizeCard)
        .filter((c): c is BoardCard => c !== null);
    }
    ready.value = true;
    // v1 (or version-less) board → write the migrated v2 document back so
    // the next load takes the fast path and `version` reflects reality.
    if (version !== STORE_VERSION) void persist();

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
      // A dedicated kind, so the Events tab and its filters can tell card
      // lifecycle apart from agent syncs.
      kind: 'card',
      agentName: card.agent || 'board',
      title: card.title,
      detail,
    });
  }

  // ---- queries ------------------------------------------------------------

  /**
   * Resolve which registered project a card belongs to. `card.project` is a
   * free-text label (usually seeded from a cwd's last segment), so it matches
   * either the project name or the project path's basename — case-insensitive.
   * Unmatched/empty labels are unassigned (`null`).
   */
  function projectIdForCard(card: BoardCard): string | null {
    const label = card.project.trim().toLowerCase();
    if (!label) return null;
    const projects = useProjectsStore().projects;
    const byName = projects.find((p) => p.name.trim().toLowerCase() === label);
    if (byName) return byName.id;
    const byBase = projects.find(
      (p) => p.path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === label
    );
    return byBase?.id ?? null;
  }

  /** Cards visible under the global project scope (`ui.ts` is the single
   * source — 'all' shows everything, a project id shows its own cards). */
  const scopedCards = computed(() => {
    const scope = useUiStore().activeProjectId;
    if (scope === 'all') return cards.value;
    return cards.value.filter((c) => projectIdForCard(c) === scope);
  });

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

  const filteredCards = computed(() => scopedCards.value.filter(matchesFilters));

  const isFiltering = computed(
    () =>
      !!filters.value.project ||
      !!filters.value.agent ||
      !!filters.value.priority ||
      !!filters.value.search.trim()
  );

  /** Filtered, ordered cards of one stage — drives both the column body and
   * its header count so the counters always reflect the active filter. */
  function cardsInStage(stage: BoardStageId): BoardCard[] {
    return filteredCards.value
      .filter((c) => c.stage === stage)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  const projectOptions = computed(() =>
    [...new Set(cards.value.map((c) => c.project).filter(Boolean))].sort()
  );

  // ---- mutations ----------------------------------------------------------

  function nextOrder(stage: BoardStageId): number {
    const inStage = cards.value.filter((c) => c.stage === stage);
    return inStage.length ? Math.max(...inStage.map((c) => c.order)) + ORDER_STEP : ORDER_STEP;
  }

  function makeCard(partial: Partial<BoardCard> = {}): BoardCard {
    const now = Date.now();
    const stage =
      partial.stage && BOARD_STAGE_IDS.includes(partial.stage) ? partial.stage : 'backlog';
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
      blocked: partial.blocked ?? false,
      blockedReason: partial.blockedReason ?? '',
      cancelled: partial.cancelled ?? false,
      touches: partial.touches ? [...partial.touches] : [],
      dependsOn: partial.dependsOn ? [...partial.dependsOn] : [],
      blocks: partial.blocks ? [...partial.blocks] : [],
      conflictsWith: partial.conflictsWith ? [...partial.conflictsWith] : [],
      stage,
      status: coerceStatus(stage, partial.status),
      statusByStage: partial.statusByStage ? { ...partial.statusByStage } : {},
      order: partial.order ?? nextOrder(stage),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** New cards always land in `backlog` (triage stage), per the board spec.
   * Under a scoped project the card takes that project's label so it stays
   * inside the scope it was created in. */
  function addCard(partial: Partial<BoardCard> = {}): BoardCard {
    const scopeProject = useUiStore().activeProject;
    const project = partial.project?.trim() || (scopeProject?.name ?? '');
    const card = makeCard({ ...partial, project, stage: 'backlog', status: null });
    cards.value.push(card);
    scheduleSave();
    logCardEvent(card, 'card created in backlog');
    return card;
  }

  function addExampleCard(): BoardCard {
    const card = makeCard({
      title: 'Example card — safe to edit or delete',
      description:
        'Example card. Fill title, project, agent and priority, then move it between stages.',
      project: 'example',
      priority: 'medium',
      acceptance: '- The card moves between stages\n- It survives a reload',
      verification: '- npm run build:web\n- open the Board view',
      stage: 'backlog',
      status: null,
    });
    cards.value.push(card);
    scheduleSave();
    logCardEvent(card, 'example card created');
    return card;
  }

  function updateCard(id: string, patch: Partial<BoardCard>): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return { ok: false };
    const { status: _status, stage: _stage, ...rest } = patch;
    Object.assign(card, rest, { id: card.id, updatedAt: Date.now() });
    // Status/stage move through their own paths (setCardStatus / moveCard)
    // so the per-stage status rules always hold — but a direct patch that
    // carries a valid status still applies, gated like setCardStatus.
    let refusal: string | null = null;
    if (_status !== undefined && STAGE_STATUSES[card.stage].includes(_status as CardStatus)) {
      refusal = reviewGateRefusal(card.id, card.stage, _status as CardStatus, card.status);
      if (!refusal) card.status = _status as CardStatus;
    }
    scheduleSave();
    if (refusal) {
      logCardEvent(card, `status → ${_status} refused: ${refusal}`);
      return { ok: false, reason: refusal };
    }
    return { ok: true };
  }

  function removeCard(id: string): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return;
    cards.value = cards.value.filter((c) => c.id !== id);
    scheduleSave();
    logCardEvent(card, `card deleted from ${card.stage}`);
  }

  function duplicateCard(id: string): BoardCard | null {
    const src = cards.value.find((c) => c.id === id);
    if (!src) return null;
    const copy = makeCard({
      ...src,
      title: `${src.title} (copy)`,
      stage: src.stage,
      status: src.status,
      order: src.order + 1,
    });
    cards.value.push(copy);
    normalizeStage(src.stage);
    scheduleSave();
    logCardEvent(copy, `duplicated from "${src.title}" in ${src.stage}`);
    return copy;
  }

  /** Rewrite a stage's order keys to a clean 10, 20, 30… sequence. */
  function normalizeStage(stage: BoardStageId): void {
    const inStage = cards.value
      .filter((c) => c.stage === stage)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    inStage.forEach((c, i) => {
      c.order = (i + 1) * ORDER_STEP;
    });
  }

  /**
   * Move a card to `to` stage, optionally before `beforeId` (a card already
   * in that stage). Same-stage calls reorder instead of moving.
   *
   * On a stage change the status follows the stage's vocabulary: a card that
   * has been in the target stage before resumes the status it left there;
   * on a first visit it gets the stage's initial status — `in_progress`, or
   * `null` for backlog/done. The outgoing status is remembered per stage.
   */
  function moveCard(id: string, to: BoardStageId, beforeId?: string | null): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card || !BOARD_STAGE_IDS.includes(to)) return;
    const from = card.stage;
    if (from !== to) {
      const prevStatus = card.status;
      if (card.status) {
        card.statusByStage = { ...card.statusByStage, [from]: card.status };
      }
      const remembered = card.statusByStage[to];
      card.stage = to;
      card.status =
        remembered && STAGE_STATUSES[to].includes(remembered)
          ? remembered
          : initialStatusFor(to);
      // The agent_tested gate also guards a RESUMED status: a card sent
      // back and returned to reviewtest must not quietly sit at
      // agent_tested while blocking findings are (still) open.
      if (card.status === 'agent_tested') {
        const refusal = reviewGateRefusal(card.id, to, 'agent_tested', prevStatus);
        if (refusal) {
          card.status = 'in_progress';
          logCardEvent(card, `resumed status agent_tested refused: ${refusal}`);
        }
      }
    }
    card.updatedAt = Date.now();

    const siblings = cards.value
      .filter((c) => c.stage === to && c.id !== id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const beforeIdx = beforeId ? siblings.findIndex((c) => c.id === beforeId) : -1;
    if (beforeIdx === -1) {
      card.order = siblings.length ? siblings[siblings.length - 1].order + ORDER_STEP : ORDER_STEP;
    } else {
      // Temporarily park halfway, then renormalize the whole stage.
      const prev = beforeIdx > 0 ? siblings[beforeIdx - 1].order : 0;
      card.order = (prev + siblings[beforeIdx].order) / 2;
      normalizeStage(to);
    }
    scheduleSave();
    if (from !== to) logCardEvent(card, `card moved ${from} → ${to}`);
  }

  /** Keyboard path: shift a card one stage left/right in BOARD_STAGE_IDS. */
  function moveCardBy(id: string, delta: -1 | 1): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return;
    const idx = BOARD_STAGE_IDS.indexOf(card.stage);
    const next = BOARD_STAGE_IDS[idx + delta];
    if (next) moveCard(id, next);
  }

  /**
   * Set the card's status inside its current stage. Invalid combinations are
   * rejected. `accepted` in reviewtest is the pipeline's terminal step — the
   * card leaves for `done` (§C: "accepted → карточка уходит в Done").
   */
  function setCardStatus(id: string, status: CardStatus): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card || !STAGE_STATUSES[card.stage].includes(status)) return { ok: false };
    const prev = card.status;
    if (prev === status) return { ok: true };
    const refusal = reviewGateRefusal(card.id, card.stage, status, prev);
    if (refusal) {
      logCardEvent(card, `status → ${status} refused: ${refusal}`);
      return { ok: false, reason: refusal };
    }
    card.status = status;
    card.updatedAt = Date.now();
    scheduleSave();
    logCardEvent(card, `status ${prev ?? '—'} → ${status} in ${card.stage}`);
    if (card.stage === 'reviewtest' && status === 'accepted') {
      moveCard(id, 'done');
    }
    return { ok: true };
  }

  /** Toggle a card flag. Flags live on the card across stages and mark it
   * out of any future auto-pickup. */
  function setCardFlag(id: string, flag: 'blocked' | 'cancelled', on: boolean): void {
    const card = cards.value.find((c) => c.id === id);
    if (!card || card[flag] === on) return;
    card[flag] = on;
    card.updatedAt = Date.now();
    scheduleSave();
    logCardEvent(card, on ? `flagged ${flag}` : `${flag} flag cleared`);
  }

  function clearFilters(): void {
    filters.value = emptyFilters();
  }

  return {
    cards,
    filters,
    ready,
    filteredCards,
    scopedCards,
    isFiltering,
    projectOptions,
    cardsInStage,
    projectIdForCard,
    initBoardStore,
    addCard,
    addExampleCard,
    updateCard,
    setCardStatus,
    setCardFlag,
    removeCard,
    duplicateCard,
    moveCard,
    moveCardBy,
    clearFilters,
  };
});
