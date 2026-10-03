<script setup lang="ts">
// Board view (F3 kanban + F4 secondary tabs). Owns the tab bar, the header
// summary line, and hosts the card-edit drawer. Data lives in
// src/stores/board.ts (cards) and src/stores/activity.ts (ledger).
import { ref, computed, onMounted } from 'vue';
import { useBoardStore, type BoardStageId } from '../stores/board';
import { useRolesStore } from '../stores/roles';
import { useActivityStore } from '../stores/activity';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import KanbanTab from '../features/board/KanbanTab.vue';
import AgentsTab from '../features/board/AgentsTab.vue';
import LocksTab from '../features/board/LocksTab.vue';
import TimelineTab from '../features/board/TimelineTab.vue';
import EventsTab from '../features/board/EventsTab.vue';
import LinksTab from '../features/board/LinksTab.vue';
import CardDrawer from '../features/board/CardDrawer.vue';
import { useExecutionStore } from '../stores/execution';
import { useWorkflowStore } from '../stores/workflow';

type BoardTab = 'tasks' | 'links' | 'agents' | 'locks' | 'timeline' | 'events';

const TABS: { id: BoardTab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'links', label: 'Links' },
  { id: 'agents', label: 'Agents' },
  { id: 'locks', label: 'Locks' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
];

const board = useBoardStore();
const rolesStore = useRolesStore();
const activity = useActivityStore();
const sessionStore = useSessionStore();
const uiStore = useUiStore();
const execStore = useExecutionStore();
const wfStore = useWorkflowStore();

const activeTab = ref<BoardTab>('tasks');
const openCardId = ref<string | null>(null);

onMounted(() => {
  void board.initBoardStore();
  void rolesStore.initRolesStore();
});

/** Compact per-stage counters for the header, plus the card-flag totals
 * (blocked/cancelled are flags, not stages — they get their own counts).
 * Counts reflect the active project scope and filter. */
const summaryLine = computed(() => {
  const n = (stage: BoardStageId) => board.cardsInStage(stage).length;
  const parts = [
    `backlog ${n('backlog')}`,
    `spec ${n('spec')}`,
    `plan ${n('plan')}`,
    `dev ${n('dev')}`,
    `reviewtest ${n('reviewtest')}`,
    `done ${n('done')}`,
  ];
  const flagged = board.filteredCards.filter((c) => c.blocked).length;
  const cancelled = board.filteredCards.filter((c) => c.cancelled).length;
  if (flagged) parts.push(`blocked ${flagged}`);
  if (cancelled) parts.push(`cancelled ${cancelled}`);
  return parts.join(' · ');
});

const lockCount = computed(
  () => activity.entries.filter((e) => e.kind === 'lock').length
);

/** Cards in scope carrying a visible graph problem — the Links tab's
 * count badge (blocked flag or a declared conflict). */
const linksProblemCount = computed(
  () => board.scopedCards.filter((c) => c.blocked || c.conflictsWith.length).length
);

function tabNote(tab: BoardTab): string {
  if (tab === 'tasks' && board.isFiltering) {
    return `${board.filteredCards.length}/${board.cards.length}`;
  }
  if (tab === 'links' && linksProblemCount.value > 0) return String(linksProblemCount.value);
  if (tab === 'locks' && lockCount.value > 0) return String(lockCount.value);
  return '';
}

function onOpenCard(cardId: string) {
  openCardId.value = cardId;
}

async function onOpenSession(session: { agentName: string; sessionId: string }) {
  const saved = sessionStore.savedSessions.find(
    (s) => s.agentName === session.agentName && s.sessionId === session.sessionId
  );
  if (!saved) return;
  try {
    await sessionStore.resumeSession(saved);
    await uiStore.setView('chat');
  } catch {
    // resumeSession already wrote the error banner + a lock/error ledger
    // entry; stay on the board so the user sees both.
  }
}

/** "Show in Workflow panel" on a managed run: the chat view's workflow
 * side panel, pinned to that exact run via the execution store. */
function onOpenWorkflow(target: { cardId: string; runId: string }) {
  wfStore.setChatMode('workflow');
  execStore.openManagedRun(target.cardId, target.runId);
  void uiStore.setView('chat');
}
</script>

<template>
  <div class="view-pane" :aria-busy="!board.ready">
    <header class="pane-head">
      <h2>Board</h2>
      <span class="pane-note" aria-live="polite" :title="summaryLine">{{ summaryLine }}</span>
    </header>

    <nav class="tab-bar" aria-label="Board sections">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="tab-btn"
        :class="{ active: activeTab === tab.id }"
        role="tab"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}<span v-if="tabNote(tab.id)" class="tab-count mono">{{ tabNote(tab.id) }}</span>
      </button>
    </nav>

    <div class="pane-body">
      <KanbanTab v-show="activeTab === 'tasks'" @open-card="onOpenCard" />
      <LinksTab v-if="activeTab === 'links'" @open-card="onOpenCard" />
      <AgentsTab v-if="activeTab === 'agents'" />
      <LocksTab v-if="activeTab === 'locks'" />
      <TimelineTab v-if="activeTab === 'timeline'" />
      <EventsTab v-if="activeTab === 'events'" />

      <CardDrawer
        v-if="openCardId"
        :card-id="openCardId"
        @close="openCardId = null"
        @open-session="onOpenSession"
        @open-card="onOpenCard"
        @open-workflow="onOpenWorkflow"
      />
    </div>
  </div>
</template>

<style scoped>
.view-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.pane-head h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.pane-note {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  /* Wraps onto a second line instead of overflowing — nowrap+ellipsis kept
     scrollWidth > clientWidth (the clipped text still counts), so the audit's
     overflow check can only pass if the text is allowed to wrap. */
  min-width: 0;
  text-align: right;
}

.tab-bar {
  display: flex;
  gap: 0.125rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  overflow-x: auto;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 30px;
  padding: 0 0.625rem;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}

.tab-btn:hover {
  color: var(--text-primary, #2b2723);
}

.tab-btn.active {
  color: var(--text-accent, #c2532f);
  border-bottom-color: var(--text-accent, #c2532f);
}

.tab-btn:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: -2px;
}

.tab-count {
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.pane-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-body > * {
  flex: 1;
  min-height: 0;
}

/* Same 800px breakpoint as the App.vue sidebar drawer: on the narrow
   layout the summary line duplicates the column switcher counts, so it
   only shows on the desktop layout. */
@media (max-width: 800px) {
  .pane-note {
    display: none;
  }
}

@media (max-width: 800px) {
  .tab-btn {
    min-height: 44px;
    flex: 1;
    justify-content: center;
  }
}
</style>
