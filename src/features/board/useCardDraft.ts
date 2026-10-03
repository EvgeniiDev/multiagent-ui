// Card-drawer draft machine (extracted for behavioral tests): the local
// editable copy of a board card, debounced back into the board store.
//
// Correctness rules this encodes:
//  - `editedFields` is the set of fields the USER touched since the draft
//    was loaded — flush() sends only those, so a stale untouched draft
//    field can never overwrite another writer's newer value.
//  - A pending debounced write belongs to the card it was made on. A card
//    switch flushes the OLD card first (with its old draft + edited set);
//    the timer is cancelled so it can never fire against the new card.
//  - Unmount flushes whatever is pending; the timer can never outlive the
//    component.
//  - Managed cards: lifecycle mutations (stage/status/blocked/cancelled)
//    are never issued from the draft — the board store refuses them too.
//
// The composable takes minimal seams (saveMs for tests, an alert sink, and
// a narrow board interface) so the whole state machine runs in node.

import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { BoardCard, BoardStageId, CardStatus, MutationResult } from '../../stores/board';
import { statusesForStage } from './columns';

export interface CardDraftDeps {
  /** The card the draft currently mirrors (reactive). */
  card: ComputedRef<BoardCard | null>;
  /** The bound card id (reactive). */
  cardId: ComputedRef<string>;
  /** Resolve a card by id — used to flush the OLD card on a switch. */
  findCard: (id: string) => BoardCard | null;
  moveCard: (id: string, stage: BoardStageId) => MutationResult;
  setCardStatus: (id: string, status: CardStatus) => MutationResult;
  setCardFlag: (id: string, flag: 'blocked' | 'cancelled', value: boolean, reason?: string) => MutationResult;
  updateCard: (id: string, patch: Partial<BoardCard>) => MutationResult;
  /** Refusal surface — alert() in the component, captured in tests. */
  onRefused: (reason: string) => void;
  /** Debounce delay — 400ms in the UI, tiny in tests. */
  saveMs?: number;
  /** Registration seam for unmount cleanup — onBeforeUnmount in the SFC,
   * scope-stop in tests. When omitted, callers own the lifecycle. */
  onDispose?: (fn: () => void) => void;
}

export interface CardDraft {
  title: string;
  description: string;
  project: string;
  agent: string;
  priority: 'high' | 'medium' | 'low';
  acceptance: string;
  verification: string;
  blocked: boolean;
  blockedReason: string;
  cancelled: boolean;
  stage: BoardStageId;
  status: CardStatus | null;
  links: { label: string; url: string }[];
  sessionKey: string;
}

export function draftFromCard(c: BoardCard): CardDraft {
  return {
    title: c.title,
    description: c.description,
    project: c.project,
    agent: c.agent,
    priority: c.priority,
    acceptance: c.acceptance,
    verification: c.verification,
    blocked: c.blocked,
    blockedReason: c.blockedReason,
    cancelled: c.cancelled,
    stage: c.stage,
    status: c.status,
    links: c.links.map((l) => ({ ...l })),
    sessionKey: c.session ? `${c.session.agentName}::${c.session.sessionId}` : '',
  };
}

const emptyDraft: CardDraft = {
  title: '',
  description: '',
  project: '',
  agent: '',
  priority: 'medium',
  acceptance: '',
  verification: '',
  blocked: false,
  blockedReason: '',
  cancelled: false,
  stage: 'backlog',
  status: null,
  links: [],
  sessionKey: '',
};

export function useCardDraft(deps: CardDraftDeps) {
  const saveMs = deps.saveMs ?? 400;

  const draft: Ref<CardDraft> = ref({ ...emptyDraft, links: [] });
  const lastSavedAt = ref<number | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Declared before the card watcher: an { immediate: true } callback runs
  // synchronously at registration — a let-declaration after it would be a
  // temporal-dead-zone ReferenceError on every mount.
  let editedFields = new Set<string>();

  /** Server-owned lifecycle on a managed card — the draft's stage/status/
   * flags never reach the board store for these. */
  function isManagedCard(c: BoardCard | null): boolean {
    return c?.execution?.managed === true;
  }

  /** Write pending draft edits. `targetId` pins the card the edits belong
   * to (a card switch flushes the old card before the draft is swapped). */
  function flush(targetId?: string) {
    saveTimer = null;
    const c = targetId ? deps.findCard(targetId) : deps.card.value;
    if (!c) return;
    const d = draft.value;
    const edited = editedFields;
    editedFields = new Set();
    const managed = isManagedCard(c);
    // Stage first (a stage change may reset the status), then the in-stage
    // status, then the flags — each through its own mutation so the
    // stage's status rules and the ledger entries stay intact. Managed
    // cards skip this whole block: these controls are disabled and the
    // board would refuse anyway.
    if (!managed) {
      if (edited.has('stage') && d.stage !== c.stage) {
        const r = deps.moveCard(c.id, d.stage);
        if (!r.ok && r.reason) deps.onRefused(r.reason);
      }
      if (edited.has('status') && d.status && d.status !== c.status) {
        const r = deps.setCardStatus(c.id, d.status);
        // The review-cycle gate refuses `agent_tested` while blocking
        // findings are open — surface the reason and snap the draft back.
        if (!r.ok && r.reason) {
          deps.onRefused(r.reason);
          draft.value.status = c.status;
        }
      }
      if (
        (edited.has('blocked') || edited.has('blockedReason')) &&
        (d.blocked !== c.blocked || d.blockedReason.trim() !== c.blockedReason)
      ) {
        const r = deps.setCardFlag(c.id, 'blocked', d.blocked, d.blocked ? d.blockedReason.trim() : '');
        if (!r.ok && r.reason) deps.onRefused(r.reason);
      }
      if (edited.has('cancelled') && d.cancelled !== c.cancelled) {
        const r = deps.setCardFlag(c.id, 'cancelled', d.cancelled);
        if (!r.ok && r.reason) deps.onRefused(r.reason);
      }
    }
    const patch: Partial<BoardCard> = {};
    if (edited.has('title')) patch.title = d.title.trim() || 'Untitled card';
    if (edited.has('description')) patch.description = d.description;
    if (edited.has('project')) patch.project = d.project.trim();
    if (edited.has('agent')) patch.agent = d.agent;
    if (edited.has('priority')) patch.priority = d.priority;
    if (edited.has('acceptance')) patch.acceptance = d.acceptance;
    if (edited.has('verification')) patch.verification = d.verification;
    if (edited.has('links')) {
      patch.links = d.links
        .filter((l) => l.label.trim() || l.url.trim())
        .map((l) => ({ label: l.label.trim(), url: l.url.trim() }));
    }
    if (edited.has('sessionKey')) {
      const sessionKey = d.sessionKey;
      patch.session = sessionKey
        ? { agentName: sessionKey.split('::')[0], sessionId: sessionKey.split('::').slice(1).join('::') }
        : null;
    }
    if (Object.keys(patch).length) {
      const r = deps.updateCard(c.id, patch);
      if (!r.ok && r.reason) deps.onRefused(r.reason);
    }
    lastSavedAt.value = Date.now();
  }

  /** Explicit one-shot write — duplicate/remove paths. */
  function flushNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    flush();
  }

  function markDirty(field: string) {
    editedFields.add(field);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush(), saveMs);
  }

  /** A managed card picked a stage/status in the UI — unreachable while
   * the control is disabled, but keep the semantics honest: the draft's
   * status follows the stage's own rules. */
  function onStagePicked() {
    const allowed = statusesForStage(draft.value.stage);
    if (!draft.value.status || !allowed.includes(draft.value.status)) {
      draft.value.status = allowed[0] ?? null;
    }
    markDirty('stage');
    markDirty('status');
  }

  function resetToCard() {
    if (deps.card.value) draft.value = draftFromCard(deps.card.value);
    editedFields = new Set();
  }

  // Card switch: cancel the pending write first, then flush it against the
  // OLD card id — the timer must never deliver old edits to the new card.
  watch(
    deps.cardId,
    (_id, prevId) => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (prevId) flush(prevId);
      }
      resetToCard();
    },
    { immediate: true },
  );

  // Same-card authoritative updates: while the drawer is open the
  // execution poll keeps writing the managed projection into board.cards
  // (stage/status/flags/project/session move under the engine). The draft
  // is the user's editable copy — refresh ONLY the server-owned managed
  // fields so the drawer reflects the engine's truth. User-editable fields
  // (title, description, agent, priority, acceptance, verification, links)
  // and any pending edit are never touched; unmanaged cards are left alone
  // entirely. This is display-only — it never schedules a save.
  watch(
    deps.card,
    (next, prev) => {
      if (!next || !prev || next.id !== prev.id) return;
      if (!isManagedCard(next)) return;
      const d = draft.value;
      d.stage = next.stage;
      d.status = next.status;
      d.project = next.project;
      d.blocked = next.blocked;
      d.blockedReason = next.blockedReason;
      d.cancelled = next.cancelled;
      d.sessionKey = next.session
        ? `${next.session.agentName}::${next.session.sessionId}`
        : '';
    },
    { deep: true },
  );

  const dispose = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    flush();
  };
  if (deps.onDispose) deps.onDispose(dispose);
  else onBeforeUnmount(dispose);

  const hasPending = computed(() => editedFields.size > 0 || saveTimer !== null);

  return {
    draft,
    lastSavedAt,
    hasPending,
    editedCount: computed(() => editedFields.size),
    markDirty,
    flush,
    flushNow,
    resetToCard,
    onStagePicked,
    isManagedCard,
  };
}
