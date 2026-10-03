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
import {
  loadKvStore,
  fetchRemoteDoc,
  mirrorLocalDoc,
  mutateRemoteDocChecked,
  type KVStore,
} from '../lib/host/storage';
import { uuid } from '../lib/uuid';
import { useActivityStore } from './activity';
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

/** Server-owned managed-execution marker projected onto a board card (U6).
 * Written into board.json exclusively by the execution domain's
 * board_projection — the client mirrors it read-only for display and
 * merge preservation, never authors it. */
export interface ManagedExecution {
  managed: true;
  runId: string | null;
  runStatus: string | null;
  controlRevision: number;
}

/** Card fields the managed lifecycle owns — mirrors MANAGED_CARD_FIELDS in
 * server/execution/execution-domain.mjs exactly. Local mutations of these
 * on a managed card are refused; a managed-aware save copies the
 * authoritative remote values. `order` is NOT in this list: it is a user
 * field for writes (same-stage reorders persist), but the server
 * projection also assigns it on stage changes, so sync reads it back. */
export const MANAGED_CARD_FIELDS = [
  'stage',
  'status',
  'statusByStage',
  'blocked',
  'blockedReason',
  'cancelled',
  'project',
  'session',
  'execution',
] as const;

/** Fields an authoritative managed row carries that local display adopts —
 * the write-protected set plus `order` (projection-assigned). */
const MANAGED_SYNC_FIELDS = [...MANAGED_CARD_FIELDS, 'order'] as const;

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
  /** Present only while the card is managed by the execution engine —
   * read-only server projection, kept by sanitizeCard for managed rows. */
  execution?: ManagedExecution;
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
  const rawExec = (c as Record<string, unknown>).execution;
  const execution =
    rawExec &&
    typeof rawExec === 'object' &&
    (rawExec as ManagedExecution).managed === true
      ? {
          managed: true as const,
          runId:
            typeof (rawExec as ManagedExecution).runId === 'string'
              ? (rawExec as ManagedExecution).runId
              : null,
          runStatus:
            typeof (rawExec as ManagedExecution).runStatus === 'string'
              ? (rawExec as ManagedExecution).runStatus
              : null,
          controlRevision:
            typeof (rawExec as ManagedExecution).controlRevision === 'number'
              ? (rawExec as ManagedExecution).controlRevision
              : 0,
        }
      : undefined;
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
    ...(execution ? { execution } : {}),
  };
}

export const useBoardStore = defineStore('board', () => {
  const cards = ref<BoardCard[]>([]);
  const filters = ref<BoardFilters>(emptyFilters());
  const ready = ref(false);
  /** Last managed-save diagnostic — surfaced in the board UI; cleared on a
   * successful authoritative write. */
  const saveError = ref<{ code: string; error: string; at: number } | null>(null);
  let store: KVStore | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending user-field deltas — per card, per FIELD, stamped with a
  // monotonic mutation generation. The managed save path merges ONLY these
  // fields onto a fresh remote row, so an untouched field of an edited
  // card (or an untouched card) is never rewritten from a stale local
  // copy, and an edit that lands mid-flight keeps its newer generation so
  // it is never cleared unshipped.
  const dirtyFields = new Map<string, Map<string, number>>();
  /** Cards created locally that the remote doc has never seen — the only
   * local-only rows a merge may add (never resurrect remote deletions). */
  const newCardIds = new Set<string>();
  const deletedCardIds = new Set<string>();
  let mutGen = 0;
  let managedSaveRunning = false;
  let managedSaveAgain = false;
  let managedSyncSeq = 0;

  function markFields(id: string, fields: string[]): void {
    let m = dirtyFields.get(id);
    if (!m) {
      m = new Map();
      dirtyFields.set(id, m);
    }
    const g = ++mutGen;
    for (const f of fields) m.set(f, g);
  }

  function markNew(id: string): void {
    newCardIds.add(id);
  }

  const hasManagedCards = computed(() =>
    cards.value.some((c) => c.execution?.managed === true)
  );

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
    if (!hasManagedCards.value) {
      dirtyFields.clear();
      newCardIds.clear();
      deletedCardIds.clear();
      await store.set('version', STORE_VERSION);
      await store.set('cards', cards.value);
      await store.save();
      return;
    }
    await persistManagedBoard();
  }

  /** Managed-board save: NEVER takes the KV last-write-wins/force path.
   * GET the fresh remote doc, merge only pending user-field deltas onto
   * fresh rows (managed-owned fields always come from remote), PUT with
   * the fresh rev, retry only on `rev_conflict`. Serialized: while a save
   * is in flight a further schedule just marks `managedSaveAgain`, and a
   * field's dirty mark is cleared only when the generation actually sent
   * still equals the current one — an edit that lands mid-PUT is never
   * lost. A protection refusal surfaces `saveError` + authoritative
   * reload; an unreachable server keeps the local mirror and dirty marks. */
  async function persistManagedBoard(): Promise<void> {
    if (managedSaveRunning) {
      managedSaveAgain = true;
      return;
    }
    managedSaveRunning = true;
    try {
      do {
        managedSaveAgain = false;
        await runManagedSaveOnce();
      } while (managedSaveAgain);
    } finally {
      managedSaveRunning = false;
    }
  }

  async function runManagedSaveOnce(): Promise<void> {
    mirrorLocalDoc(STORE_PATH, { version: STORE_VERSION, cards: cards.value });
    // Nothing pending → no PUT. A stray debounce must not bump the remote
    // rev (a no-op write would still conflict every other writer's CAS).
    if (!dirtyFields.size && !newCardIds.size && !deletedCardIds.size) return;
    // Field gens actually merged into the PUT body — cleared only when no
    // newer generation exists on success. Read inside the CAS callback:
    // each attempt re-reads BOTH the fresh remote doc and the live local
    // array (values + generations from the same moment — a captured stale
    // array tagged with new gens would ship outdated values).
    const sent = new Map<string, Map<string, number>>();
    const sentNew = new Set<string>();
    const sentDeleted = new Set<string>();
    const res = await mutateRemoteDocChecked(STORE_PATH, (remote) => {
      sent.clear();
      sentNew.clear();
      sentDeleted.clear();
      return mergeBoardCards(remote, cards.value, sent, sentNew, sentDeleted);
    });
    if (res.ok) {
      for (const [id, fields] of sent) {
        const df = dirtyFields.get(id);
        if (!df) continue;
        for (const [f, gen] of fields) {
          if (df.get(f) === gen) df.delete(f); // newer edit → stays dirty
        }
        if (!df.size) dirtyFields.delete(id);
      }
      for (const id of sentNew) newCardIds.delete(id);
      for (const id of sentDeleted) {
        deletedCardIds.delete(id);
        dirtyFields.delete(id);
      }
      saveError.value = null;
      // The PUT response carries no document — pull the merged result so
      // the server-side managed overlay lands locally immediately.
      await adoptRemoteBoard();
      return;
    }
    saveError.value = {
      code: res.reason === 'rejected' ? (res.code ?? 'rejected') : res.reason,
      error: res.error,
      at: Date.now(),
    };
    if (res.reason !== 'unavailable') {
      // rev_conflict exhausted or a protection refusal — converge on the
      // authoritative document before the user edits again.
      await adoptRemoteBoard();
    }
  }

  /** Rebuild local cards from the remote document: remote rows win for
   * every field without a pending local delta (including full managed
   * lifecycle), remote-only rows appear, rows deleted remotely disappear
   * (a remote deletion is never resurrected), and still-dirty fields keep
   * their unsaved local values over the remote base. */
  async function adoptRemoteBoard(): Promise<boolean> {
    const remote = await fetchRemoteDoc(STORE_PATH);
    if (remote === 'error' || remote === 'missing') return false;
    const remoteCards = (Array.isArray(remote.data?.cards) ? remote.data.cards : [])
      .map(sanitizeCard)
      .filter((c): c is BoardCard => c !== null);
    const remoteIds = new Set(remoteCards.map((c) => c.id));
    const localById = new Map(cards.value.map((c) => [c.id, c]));
    const next: BoardCard[] = [];
    for (const rc of remoteCards) {
      if (deletedCardIds.has(rc.id)) continue;
      const lc = localById.get(rc.id);
      const df = dirtyFields.get(rc.id);
      if (lc && df?.size) {
        // Remote row is the base — pending local field deltas overlay it;
        // managed-owned fields never come from the local copy.
        const merged: Record<string, unknown> = { ...rc };
        const managed = rc.execution?.managed === true;
        const lrec = lc as unknown as Record<string, unknown>;
        for (const f of df.keys()) {
          if (managed && (MANAGED_CARD_FIELDS as readonly string[]).includes(f)) continue;
          merged[f] = lrec[f];
        }
        next.push(merged as unknown as BoardCard);
      } else {
        next.push(rc);
      }
    }
    for (const c of cards.value) {
      if (remoteIds.has(c.id) || deletedCardIds.has(c.id)) continue;
      if (newCardIds.has(c.id)) next.push(c); // locally created, unsaved
    }
    cards.value = next;
    mirrorLocalDoc(STORE_PATH, { version: STORE_VERSION, cards: next });
    return true;
  }

  /** Copy the server's managed-row fields into local rows — the read path
   * the execution store uses so a poll never authors lifecycle. Only rows
   * that are managed REMOTELY are overlaid (a stale local marker can't
   * fake one in), and nothing here schedules a persistence write.
   * Returns true when an authoritative remote read succeeded (regardless
   * of whether any field changed); the latest issued call wins so an
   * older response can't roll back a newer sync. */
  async function syncManagedRows(): Promise<boolean> {
    const my = ++managedSyncSeq;
    const remote = await fetchRemoteDoc(STORE_PATH);
    if (remote === 'error' || remote === 'missing') return false;
    if (my !== managedSyncSeq) return false; // superseded — newer read owns state
    const remoteCards = Array.isArray(remote.data?.cards) ? remote.data.cards : [];
    const remoteById = new Map<string, Record<string, unknown>>();
    for (const rc of remoteCards) {
      if (rc && typeof rc === 'object' && typeof (rc as BoardCard).id === 'string') {
        remoteById.set((rc as BoardCard).id, rc as Record<string, unknown>);
      }
    }
    for (const c of cards.value) {
      const rc = remoteById.get(c.id);
      if (!rc || (rc.execution as ManagedExecution | undefined)?.managed !== true) continue;
      const rec = c as unknown as Record<string, unknown>;
      for (const f of MANAGED_SYNC_FIELDS) {
        if (f in rc) rec[f] = rc[f];
        else if (f in rec) delete rec[f];
      }
    }
    return true;
  }

  /** Managed-aware merge for the CAS save: remote rows are the base; only
   * locally dirty FIELDS contribute their values over the remote row
   * (managed-owned fields are never taken from the local copy), locally
   * created rows are appended, and user deletions drop unmanaged rows only
   * (a managed deletion is never submitted). `sent`/`sentNew`/`sentDeleted`
   * record what the attempt actually shipped so success clears exactly
   * those — and only those — generations. */
  function mergeBoardCards(
    remote: Record<string, unknown>,
    localCards: BoardCard[],
    sent: Map<string, Map<string, number>>,
    sentNew: Set<string>,
    sentDeleted: Set<string>,
  ): Record<string, unknown> {
    const remoteCards = Array.isArray(remote.cards) ? remote.cards : [];
    const localById = new Map(localCards.map((c) => [c.id, c]));
    const managedRow = (r: unknown): r is Record<string, unknown> =>
      !!r &&
      typeof r === 'object' &&
      (r as { execution?: ManagedExecution }).execution?.managed === true;
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const rc of remoteCards) {
      const id = rc && typeof rc === 'object' ? (rc as BoardCard).id : null;
      if (typeof id !== 'string' || !rc || typeof rc !== 'object') continue;
      seen.add(id);
      if (deletedCardIds.has(id)) {
        if (managedRow(rc)) out.push(rc); // managed rows are never deleted here
        else sentDeleted.add(id);
        continue;
      }
      const lc = localById.get(id);
      const df = dirtyFields.get(id);
      if (!lc || !df?.size) {
        out.push(rc); // untouched — remote row verbatim
        continue;
      }
      const managed = managedRow(rc);
      const merged: Record<string, unknown> = { ...rc };
      const lrec = lc as unknown as Record<string, unknown>;
      const shipped = new Map<string, number>();
      for (const [f, gen] of df) {
        if (managed && (MANAGED_CARD_FIELDS as readonly string[]).includes(f)) continue;
        merged[f] = lrec[f];
        shipped.set(f, gen);
      }
      if (shipped.size) sent.set(id, shipped);
      out.push(merged);
    }
    for (const lc of localCards) {
      if (seen.has(lc.id) || deletedCardIds.has(lc.id)) continue;
      if (newCardIds.has(lc.id)) {
        out.push(lc);
        sentNew.add(lc.id);
      }
    }
    return { ...remote, version: STORE_VERSION, cards: out };
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

  /** All cards — the board is scoped by its own filter row (f.project), not
   * by the sidebar's project-scope selector, which is a session-list filter
   * and is not reachable from the board view. */
  const scopedCards = computed(() => cards.value);

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
   * Unnamed cards take the board's own project filter so they stay visible
   * under the filter the user is looking at. */
  function addCard(partial: Partial<BoardCard> = {}): BoardCard {
    const project = partial.project?.trim() || filters.value.project || '';
    const card = makeCard({ ...partial, project, stage: 'backlog', status: null });
    cards.value.push(card);
    markNew(card.id);
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
    markNew(card.id);
    scheduleSave();
    logCardEvent(card, 'example card created');
    return card;
  }

  const MANAGED_REFUSAL =
    'this card is managed by the execution engine — its stage, status, flags, ' +
    'project and session are server-owned; control it from the managed execution section';

  function updateCard(id: string, patch: Partial<BoardCard>): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return { ok: false };
    const { status: _status, stage: _stage, ...rest } = patch;
    if (card.execution?.managed === true) {
      // Managed lifecycle fields are never authored from a draft — strip
      // them and report which ones the patch tried to move.
      const touched: string[] = [];
      if (_status !== undefined && _status !== card.status) touched.push('status');
      if (_stage !== undefined && _stage !== card.stage) touched.push('stage');
      const rec = rest as Record<string, unknown>;
      const self = card as unknown as Record<string, unknown>;
      for (const f of MANAGED_CARD_FIELDS) {
        if (!(f in rec)) continue;
        if (JSON.stringify(rec[f]) !== JSON.stringify(self[f])) touched.push(f);
        delete rec[f];
      }
      // Only genuinely-changed user fields become deltas — a full stale
      // draft never rewrites fields the user did not touch.
      const changed = Object.keys(rest).filter(
        (f) => JSON.stringify(rec[f]) !== JSON.stringify(self[f]),
      );
      if (!changed.length) {
        return touched.length ? { ok: false, reason: MANAGED_REFUSAL } : { ok: true };
      }
      Object.assign(card, rest, { id: card.id, updatedAt: Date.now() });
      markFields(id, [...changed, 'updatedAt']);
      scheduleSave();
      return touched.length ? { ok: false, reason: MANAGED_REFUSAL } : { ok: true };
    }
    // Only fields that actually differ from the card become deltas — a
    // whole-draft flush from a stale drawer never overwrites fields the
    // user did not edit.
    const rec = rest as Record<string, unknown>;
    const self = card as unknown as Record<string, unknown>;
    const changed = Object.keys(rest).filter(
      (f) => JSON.stringify(rec[f]) !== JSON.stringify(self[f]),
    );
    // Status/stage move through their own paths (setCardStatus / moveCard)
    // so the per-stage status rules always hold — but a direct patch that
    // carries a valid status still applies, gated like setCardStatus.
    let refusal: string | null = null;
    if (_status !== undefined && STAGE_STATUSES[card.stage].includes(_status as CardStatus)) {
      refusal = reviewGateRefusal(card.id, card.stage, _status as CardStatus, card.status);
      if (!refusal) {
        card.status = _status as CardStatus;
        changed.push('status');
      }
    }
    if (!changed.length) {
      if (refusal) {
        logCardEvent(card, `status → ${_status} refused: ${refusal}`);
        return { ok: false, reason: refusal };
      }
      return { ok: true }; // nothing changed — no write at all
    }
    Object.assign(card, rest, { id: card.id, updatedAt: Date.now() });
    markFields(id, [...changed, 'updatedAt']);
    scheduleSave();
    if (refusal) {
      logCardEvent(card, `status → ${_status} refused: ${refusal}`);
      return { ok: false, reason: refusal };
    }
    return { ok: true };
  }

  function removeCard(id: string): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return { ok: false };
    if (card.execution?.managed === true) {
      // The server refuses a managed row's deletion via the legacy API —
      // refuse locally so the user gets the reason, not a silent 409.
      return { ok: false, reason: `${MANAGED_REFUSAL} — it cannot be deleted here` };
    }
    cards.value = cards.value.filter((c) => c.id !== id);
    dirtyFields.delete(id);
    newCardIds.delete(id);
    deletedCardIds.add(id);
    scheduleSave();
    logCardEvent(card, `card deleted from ${card.stage}`);
    return { ok: true };
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
    markNew(copy.id);
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
      const next = (i + 1) * ORDER_STEP;
      if (c.order !== next) {
        c.order = next;
        markFields(c.id, ['order']);
      }
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
  function moveCard(id: string, to: BoardStageId, beforeId?: string | null): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card || !BOARD_STAGE_IDS.includes(to)) return { ok: false };
    const from = card.stage;
    if (card.execution?.managed === true && from !== to) {
      // Cross-stage placement is server-owned for managed cards; a
      // same-stage reorder is still a user edit (order is not protected).
      return { ok: false, reason: MANAGED_REFUSAL };
    }
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
    markFields(
      id,
      from !== to
        ? ['stage', 'status', 'statusByStage', 'order', 'updatedAt']
        : ['order', 'updatedAt'],
    );
    scheduleSave();
    if (from !== to) logCardEvent(card, `card moved ${from} → ${to}`);
    return { ok: true };
  }

  /** Keyboard path: shift a card one stage left/right in BOARD_STAGE_IDS. */
  function moveCardBy(id: string, delta: -1 | 1): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return { ok: false };
    const idx = BOARD_STAGE_IDS.indexOf(card.stage);
    const next = BOARD_STAGE_IDS[idx + delta];
    return next ? moveCard(id, next) : { ok: true };
  }

  /**
   * Set the card's status inside its current stage. Invalid combinations are
   * rejected. `accepted` in reviewtest is the pipeline's terminal step — the
   * card leaves for `done` (§C: "accepted → карточка уходит в Done").
   */
  function setCardStatus(id: string, status: CardStatus): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card || !STAGE_STATUSES[card.stage].includes(status)) return { ok: false };
    if (card.execution?.managed === true) {
      return { ok: false, reason: MANAGED_REFUSAL };
    }
    const prev = card.status;
    if (prev === status) return { ok: true };
    const refusal = reviewGateRefusal(card.id, card.stage, status, prev);
    if (refusal) {
      logCardEvent(card, `status → ${status} refused: ${refusal}`);
      return { ok: false, reason: refusal };
    }
    card.status = status;
    card.updatedAt = Date.now();
    markFields(id, ['status', 'updatedAt']);
    scheduleSave();
    logCardEvent(card, `status ${prev ?? '—'} → ${status} in ${card.stage}`);
    if (card.stage === 'reviewtest' && status === 'accepted') {
      void moveCard(id, 'done');
    }
    return { ok: true };
  }

  /**
   * Toggle a card flag. Flags live on the card across stages and mark it
   * out of any future auto-pickup — blocked is a FLAG, not a column, so the
   * card keeps its stage and stays visibly marked there.
   *
   * `blocked` and its `blockedReason` are written in the SAME mutation: a
   * flag without a reason ("blocked in dev — why?") or a reason with no
   * flag is the inconsistent pair the pipeline flagged live, so the two
   * never land in separate writes. `reason` overrides the stored text;
   * clearing the flag clears the reason unless one is given (mirrors
   * `boardctl block/unblock`).
   */
  function setCardFlag(
    id: string,
    flag: 'blocked' | 'cancelled',
    on: boolean,
    reason?: string
  ): MutationResult {
    const card = cards.value.find((c) => c.id === id);
    if (!card) return { ok: false };
    if (card.execution?.managed === true) {
      // blocked/cancelled are server-owned while managed — a visible
      // refusal beats a write the server would reject wholesale.
      return { ok: false, reason: MANAGED_REFUSAL };
    }
    // No-op only when nothing would change — a reason passed for an
    // already-set flag is still written (the pair stays in one mutation).
    if (
      card[flag] === on &&
      (flag !== 'blocked' || reason === undefined || reason === card.blockedReason)
    ) {
      return { ok: true };
    }
    card[flag] = on;
    const fields = [flag, 'updatedAt'];
    if (flag === 'blocked') {
      if (reason !== undefined) card.blockedReason = reason;
      else if (!on) card.blockedReason = '';
      fields.push('blockedReason');
    }
    card.updatedAt = Date.now();
    markFields(id, fields);
    scheduleSave();
    const detail = flag === 'blocked' && on && card.blockedReason
      ? `: ${card.blockedReason}`
      : '';
    logCardEvent(card, on ? `flagged ${flag}${detail}` : `${flag} flag cleared`);
    return { ok: true };
  }

  // ---- managed projection -------------------------------------------------

  /** Adopt the server projection for one managed card — display state
   * only; this never marks fields dirty and never schedules a save. The
   * marker carries the wire truth {managed, runId, runStatus,
   * controlRevision}; stage/status come from the view's projection. */
  function applyManagedProjection(view: {
    cardId: string;
    controlRevision: number;
    currentRunId: string | null;
    runs?: { id: string; status?: string | null }[];
    projection: { stage: string; status: string | null } | null;
  }): void {
    const card = cards.value.find((c) => c.id === view.cardId);
    if (!card) return;
    // Never roll back to an older control revision than the one already
    // displayed — the caller's request ordering guards this, this is the
    // backstop for an out-of-order projection write.
    if (
      card.execution?.managed === true &&
      view.controlRevision < card.execution.controlRevision
    ) {
      return;
    }
    const runStatus = view.currentRunId
      ? (view.runs ?? []).find((r) => r.id === view.currentRunId)?.status ?? null
      : null;
    card.execution = {
      managed: true,
      runId: view.currentRunId,
      runStatus,
      controlRevision: view.controlRevision,
    };
    const p = view.projection;
    if (p && BOARD_STAGE_IDS.includes(p.stage as BoardStageId)) {
      card.stage = p.stage as BoardStageId;
      card.status = coerceStatus(card.stage, p.status);
    }
  }

  /** The card is not (or no longer) managed server-side — drop the local
   * marker so the drawer stops offering managed controls. Read path only. */
  function clearManagedProjection(cardId: string): void {
    const card = cards.value.find((c) => c.id === cardId);
    if (card?.execution?.managed === true) delete card.execution;
  }

  function clearFilters(): void {
    filters.value = emptyFilters();
  }

  return {
    cards,
    filters,
    ready,
    saveError,
    hasManagedCards,
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
    applyManagedProjection,
    clearManagedProjection,
    syncManagedRows,
    adoptRemoteBoard,
    persistManagedBoard,
    clearFilters,
  };
});
