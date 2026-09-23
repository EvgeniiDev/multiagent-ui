<script setup lang="ts">
// Board view (F3 kanban + F4 secondary tabs). Owns the tab bar, the header
// summary line, and hosts the card-edit drawer. Data lives in
// src/stores/board.ts (cards) and src/stores/activity.ts (ledger).
import { ref, computed, onMounted } from 'vue';
import { useBoardStore, type BoardStageId } from '../stores/board';
import { useActivityStore } from '../stores/activity';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import KanbanTab from '../features/board/KanbanTab.vue';
import AgentsTab from '../features/board/AgentsTab.vue';
import LocksTab from '../features/board/LocksTab.vue';
import TimelineTab from '../features/board/TimelineTab.vue';
import EventsTab from '../features/board/EventsTab.vue';
import CardDrawer from '../features/board/CardDrawer.vue';

type BoardTab = 'tasks' | 'agents' | 'locks' | 'timeline' | 'events';

const TABS: { id: BoardTab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'agents', label: 'Agents' },
  { id: 'locks', label: 'Locks' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
];

const board = useBoardStore();
const activity = useActivityStore();
const sessionStore = useSessionStore();
const uiStore = useUiStore();

const activeTab = ref<BoardTab>('tasks');
const openCardId = ref<string | null>(null);

onMounted(() => {
  void board.initBoardStore();
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

function tabNote(tab: BoardTab): string {
  if (tab === 'tasks' && board.isFiltering) {
    return `${board.filteredCards.length}/${board.cards.length}`;
  }
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
      <AgentsTab v-if="activeTab === 'agents'" />
      <LocksTab v-if="activeTab === 'locks'" />
      <TimelineTab v-if="activeTab === 'timeline'" />
      <EventsTab v-if="activeTab === 'events'" />

      <CardDrawer
        v-if="openCardId"
        :card-id="openCardId"
        @close="openCardId = null"
        @open-session="onOpenSession"
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

@media (max-width: 800px) {
  .tab-btn {
    min-height: 44px;
    flex: 1;
    justify-content: center;
  }
}
</style>
