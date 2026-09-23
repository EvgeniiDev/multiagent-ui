<script setup lang="ts">
import { ref, computed } from 'vue';
import type { BoardCard, BoardStageId, CardStatus } from '../../stores/board';
import { useRolesStore } from '../../stores/roles';
import { statusBreakdown, type BoardStageDef } from './columns';
import BoardCardItem from './BoardCardItem.vue';

const props = defineProps<{
  col: BoardStageDef;
  cards: BoardCard[];
}>();

const emit = defineEmits<{
  add: [];
  open: [card: BoardCard];
  move: [cardId: string, to: BoardStageId, beforeId?: string | null];
  'set-status': [cardId: string, status: CardStatus];
  'set-flag': [cardId: string, flag: 'blocked' | 'cancelled', on: boolean];
  duplicate: [cardId: string];
  remove: [cardId: string];
  reorder: [cardId: string, delta: -1 | 1];
}>();

// HTML5 drag & drop state. `depth` tracks nested dragenter/leave so the
// highlight doesn't flicker when crossing card boundaries.
const depth = ref(0);
const dropBeforeId = ref<string | null>(null);
const dragActive = computed(() => depth.value > 0);

/** Per-status tally inside this stage, e.g. `in_progress 1 / review 1`. */
const breakdown = computed(() => statusBreakdown(props.col.id, props.cards));

/** Cards in this stage carrying the `blocked` flag — counted separately
 * from the status split (the flag can sit on a card in any status). */
const blockedCount = computed(() => props.cards.filter((c) => c.blocked).length);

// Stage-role selector: the role bound to this stage in roles.json. Empty
// means "as now — any runner picks up the stage's cards".
const rolesStore = useRolesStore();
const stageRole = computed(() => rolesStore.roleForStage(props.col.id));
const stageRoleNoRunner = computed(
  () => !!stageRole.value && !rolesStore.roleHasRunner(stageRole.value)
);

function onStageRole(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  try {
    rolesStore.setStageRole(props.col.id, value || null);
  } catch (e) {
    // The select lists real roles only, so a throw here means a stale
    // option raced a delete — log it; the next render resyncs the value.
    console.error('setStageRole failed:', e);
  }
}

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
    :aria-label="`${col.label} stage, ${cards.length} cards`"
  >
    <header class="col-head">
      <span class="col-label">{{ col.label }}</span>
      <span class="col-count">{{ cards.length }}</span>
      <span
        v-if="breakdown"
        class="col-statuses"
        :title="`${col.label}: ${breakdown}`"
      >{{ breakdown }}</span>
      <span
        v-if="blockedCount > 0"
        class="col-blocked"
        :title="`${blockedCount} card(s) flagged blocked`"
      >{{ blockedCount }} blocked</span>
      <select
        class="col-role"
        :class="{ 'no-runner': stageRoleNoRunner }"
        :value="stageRole?.id ?? ''"
        data-testid="col-role-select"
        :aria-label="`Role for ${col.label} stage`"
        :title="stageRole
          ? `Stage role: ${stageRole.label} (${stageRole.cli})${stageRoleNoRunner ? ' — no runner' : ''}`
          : 'No stage role — any runner picks up'"
        @change="onStageRole"
        @click.stop
      >
        <option value="">any runner</option>
        <option v-for="r in rolesStore.roles" :key="r.id" :value="r.id">{{ r.label }}</option>
      </select>
      <button
        class="col-add"
        :aria-label="`Add card (lands in Backlog)`"
        :title="`Add card — lands in Backlog`"
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
          @set-status="(id, s) => emit('set-status', id, s)"
          @set-flag="(id, f, on) => emit('set-flag', id, f, on)"
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

.col-statuses {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.col-blocked {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  color: var(--bg-danger, #b3402e);
}

.col-role {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 7.5rem;
  padding: 0.0625rem 0.125rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  cursor: pointer;
}

.col-role.no-runner {
  color: var(--bg-danger, #b3402e);
  border-color: var(--bg-danger, #b3402e);
}

.col-role:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
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

@media (max-width: 800px) {
  /* Hit area grows, the 13px icon stays the same. */
  .col-add {
    width: 44px;
    height: 44px;
  }
}
</style>
