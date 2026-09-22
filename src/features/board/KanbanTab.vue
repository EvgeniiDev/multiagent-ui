<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useBoardStore, type BoardCard, type BoardColumnId } from '../../stores/board';
import { useSessionStore } from '../../stores/session';
import { projectName } from '../../stores/activity';
import { BOARD_COLUMNS } from './columns';
import BoardColumn from './BoardColumn.vue';
import BoardFilters from './BoardFilters.vue';

const emit = defineEmits<{
  'open-card': [cardId: string];
}>();

const board = useBoardStore();
const sessionStore = useSessionStore();

// <768px switches the board to a single stacked column behind a segmented
// switcher — the spec forbids a horizontally scrolling board on phones.
const isPhone = ref(false);
let mql: MediaQueryList | null = null;
function syncMql() {
  if (mql) isPhone.value = mql.matches;
}
onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia('(max-width: 767px)');
    syncMql();
    mql.addEventListener('change', syncMql);
  }
});
onBeforeUnmount(() => {
  if (mql) mql.removeEventListener('change', syncMql);
});

const activeCol = ref<BoardColumnId>('inbox');
const activeColDef = computed(
  () => BOARD_COLUMNS.find((c) => c.id === activeCol.value) ?? BOARD_COLUMNS[0]
);

const hasCards = computed(() => board.cards.length > 0);
const hasVisible = computed(() => board.filteredCards.length > 0);

function onOpen(card: BoardCard) {
  emit('open-card', card.id);
}

function onAdd() {
  // New cards land in `inbox` whichever column the button sits in — the
  // board treats inbox as the single triage entry point. If a session is
  // live, its cwd's last segment seeds the project field.
  const cwd = sessionStore.currentSession?.cwd;
  const card = board.addCard({
    title: '',
    project: cwd ? projectName(cwd) : '',
  });
  emit('open-card', card.id);
}

function onExample() {
  const card = board.addExampleCard();
  emit('open-card', card.id);
}

function onMove(cardId: string, to: BoardColumnId, beforeId?: string | null) {
  board.moveCard(cardId, to, beforeId ?? null);
}

function onReorder(cardId: string, delta: -1 | 1) {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return;
  const list = board.cardsInColumn(card.status);
  const i = list.findIndex((c) => c.id === cardId);
  if (i === -1) return;
  if (delta < 0 && i > 0) {
    board.moveCard(cardId, card.status, list[i - 1].id);
  } else if (delta > 0 && i < list.length - 1) {
    const next = list[i + 2];
    board.moveCard(cardId, card.status, next ? next.id : null);
  }
}
</script>

<template>
  <div class="kanban-tab">
    <BoardFilters />

    <div v-if="!hasCards" class="board-empty" aria-live="polite">
      <p class="empty-title">No cards yet</p>
      <p class="empty-text">
        Cards are tasks for people and agents. Use the + button in a column
        header — a new card lands in <span class="mono">Inbox</span> — then click it to
        fill in the brief, acceptance criteria and verification steps.
      </p>
      <div class="empty-actions">
        <button class="empty-btn primary" @click="onAdd">New card</button>
        <button class="empty-btn" @click="onExample">Add example card</button>
      </div>
    </div>

    <template v-else>
      <p v-if="board.isFiltering && !hasVisible" class="filter-empty">
        No cards match the filter.
        <button class="filter-clear" @click="board.clearFilters()">Clear filter</button>
      </p>

      <!-- Phone: column switcher + one stacked column. -->
      <template v-if="isPhone">
        <div class="col-switcher" role="tablist" aria-label="Board columns">
          <button
            v-for="col in BOARD_COLUMNS"
            :key="col.id"
            class="switch-btn"
            :class="{ active: activeCol === col.id }"
            role="tab"
            :aria-selected="activeCol === col.id"
            @click="activeCol = col.id"
          >{{ col.label }} <span class="switch-count">{{ board.cardsInColumn(col.id).length }}</span></button>
        </div>
        <div class="col-single">
          <BoardColumn
            :col="activeColDef"
            :cards="board.cardsInColumn(activeColDef.id)"
            @add="onAdd"
            @open="onOpen"
            @move="onMove"
            @duplicate="(id) => board.duplicateCard(id)"
            @remove="(id) => board.removeCard(id)"
            @reorder="onReorder"
          />
        </div>
      </template>

      <!-- Tablet/desktop: all columns side by side, scrolls horizontally
           inside the pane (never a page-level scroll). -->
      <div v-else class="cols-scroll">
        <BoardColumn
          v-for="col in BOARD_COLUMNS"
          :key="col.id"
          :col="col"
          :cards="board.cardsInColumn(col.id)"
          @add="onAdd"
          @open="onOpen"
          @move="onMove"
          @duplicate="(id) => board.duplicateCard(id)"
          @remove="(id) => board.removeCard(id)"
          @reorder="onReorder"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.kanban-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.cols-scroll {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(13.5rem, 1fr);
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  overflow-x: auto;
  overflow-y: hidden;
}

.cols-scroll > * {
  min-height: 0;
}

@media (min-width: 768px) and (max-width: 1279px) {
  /* Tablet: narrower columns, ~2 visible, the rest via the pane's
     horizontal scroll. */
  .cols-scroll {
    grid-auto-columns: 15rem;
  }
}

.board-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 2rem;
  text-align: center;
}

.empty-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary, #2b2723);
}

.empty-text {
  margin: 0;
  max-width: 26rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--text-secondary, #6b6259);
}

.empty-text .mono {
  font-family: var(--font-mono, monospace);
}

.empty-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.625rem;
}

.empty-btn {
  min-height: 30px;
  padding: 0 0.75rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}

.empty-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.empty-btn.primary {
  background: var(--bg-primary, #c2532f);
  border-color: var(--bg-primary, #c2532f);
  color: #fff;
}

.empty-btn.primary:hover {
  background: var(--bg-primary-hover, #a8431f);
}

.filter-empty {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  color: var(--text-muted, #a39a8e);
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.filter-clear {
  border: none;
  background: transparent;
  color: var(--text-accent, #c2532f);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  text-decoration: underline;
}

.col-switcher {
  display: flex;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.switch-btn {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 0 0.75rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.switch-btn.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  border-color: var(--text-accent, #c2532f);
  color: var(--text-accent, #c2532f);
}

.switch-count {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
}

.col-single {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0.625rem 0.75rem;
}

.col-single > * {
  flex: 1;
  min-height: 0;
}
</style>
