<script setup lang="ts">
import { ref, computed } from 'vue';
import type { BoardCard, BoardColumnId } from '../../stores/board';
import type { BoardColumnDef } from './columns';
import BoardCardItem from './BoardCardItem.vue';

const props = defineProps<{
  col: BoardColumnDef;
  cards: BoardCard[];
}>();

const emit = defineEmits<{
  add: [];
  open: [card: BoardCard];
  move: [cardId: string, to: BoardColumnId, beforeId?: string | null];
  duplicate: [cardId: string];
  remove: [cardId: string];
  reorder: [cardId: string, delta: -1 | 1];
}>();

// HTML5 drag & drop state. `depth` tracks nested dragenter/leave so the
// highlight doesn't flicker when crossing card boundaries.
const depth = ref(0);
const dropBeforeId = ref<string | null>(null);
const dragActive = computed(() => depth.value > 0);

/** Cards parked in `blocked` that name what blocks them. */
const notedBlockers = computed(
  () => props.cards.filter((c) => c.blockedBy.trim().length > 0).length
);

function cardIdFromDrag(event: DragEvent): string | null {
  return event.dataTransfer?.getData('application/x-board-card') || null;
}

function onDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('application/x-board-card')) return;
  event.preventDefault();
  depth.value += 1;
}

function onDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('application/x-board-card')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const el = (event.target as HTMLElement | null)?.closest?.('.board-card');
  dropBeforeId.value = el ? el.getAttribute('data-card-id') : null;
}

function onDragLeave(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('application/x-board-card')) return;
  depth.value = Math.max(0, depth.value - 1);
  if (depth.value === 0) dropBeforeId.value = null;
}

function onDrop(event: DragEvent) {
  const id = cardIdFromDrag(event);
  depth.value = 0;
  if (!id) return;
  event.preventDefault();
  const beforeId = dropBeforeId.value;
  dropBeforeId.value = null;
  if (id === beforeId) return;
  emit('move', id, props.col.id, beforeId);
}

function onDragEnd() {
  depth.value = 0;
  dropBeforeId.value = null;
}
</script>

<template>
  <section
    class="board-col"
    :data-col="col.id"
    :aria-label="`${col.label} column, ${cards.length} cards`"
  >
    <header class="col-head">
      <span class="col-label">{{ col.label }}</span>
      <span class="col-count">{{ cards.length }}</span>
      <span
        v-if="col.id === 'blocked' && notedBlockers > 0"
        class="col-blocked"
        :title="`${notedBlockers} card(s) name what blocks them`"
      >{{ notedBlockers }} blocked</span>
      <button
        class="col-add"
        :aria-label="`Add card (lands in Inbox)`"
        :title="`Add card — lands in Inbox`"
        @click="emit('add')"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </header>

    <div
      class="col-body"
      :class="{ 'drop-target': dragActive }"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div
        v-for="card in cards"
        :key="card.id"
        class="card-slot"
        :class="{ 'drop-before': dragActive && dropBeforeId === card.id }"
      >
        <BoardCardItem
          :card="card"
          @open="(c) => emit('open', c)"
          @move="(id, to, beforeId) => emit('move', id, to, beforeId)"
          @duplicate="(id) => emit('duplicate', id)"
          @remove="(id) => emit('remove', id)"
          @reorder="(id, delta) => emit('reorder', id, delta)"
          @dragend="onDragEnd"
        />
      </div>
      <div
        v-if="dragActive && !dropBeforeId"
        class="drop-end"
        aria-hidden="true"
      />
      <p v-if="cards.length === 0" class="col-empty">No cards</p>
    </div>
  </section>
</template>

<style scoped>
.board-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-sidebar, #f6f2ec);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-lg, 10px);
}

.col-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.col-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
}

.col-count {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
}

.col-blocked {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  color: var(--bg-danger, #b3402e);
}

.col-add {
  margin-left: auto;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  cursor: pointer;
}

.col-add:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-accent, #c2532f);
}

.col-add:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
}

.col-body {
  flex: 1;
  min-height: 3rem;
  overflow-y: auto;
  padding: 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  border-radius: 0 0 var(--radius-lg, 10px) var(--radius-lg, 10px);
}

.col-body.drop-target {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

/* Insertion marker above the card the drag is hovering over. */
.card-slot.drop-before::before {
  content: '';
  display: block;
  height: 2px;
  margin-bottom: 0.375rem;
  border-radius: 1px;
  background: var(--text-accent, #c2532f);
}

.drop-end {
  height: 2px;
  border-radius: 1px;
  background: var(--text-accent, #c2532f);
}

.col-empty {
  margin: 0;
  padding: 0.375rem 0.25rem;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}
</style>
