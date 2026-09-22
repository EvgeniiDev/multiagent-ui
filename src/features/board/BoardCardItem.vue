<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import type { BoardCard, BoardColumnId } from '../../stores/board';
import { BOARD_COLUMNS, columnLabel } from './columns';
import { fmtStamp } from './format';

const props = defineProps<{
  card: BoardCard;
}>();

const emit = defineEmits<{
  open: [card: BoardCard];
  move: [cardId: string, to: BoardColumnId, beforeId?: string | null];
  duplicate: [cardId: string];
  remove: [cardId: string];
  reorder: [cardId: string, delta: -1 | 1];
  dragstart: [cardId: string, event: DragEvent];
  dragend: [];
}>();

const menuOpen = ref(false);

const otherColumns = computed(() => BOARD_COLUMNS.filter((c) => c.id !== props.card.status));

const PRIORITY_LABEL: Record<string, string> = { high: 'high', medium: 'med', low: 'low' };

function toggleMenu(event: Event) {
  event.stopPropagation();
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    document.addEventListener('click', closeMenu, { once: true });
  }
}

function closeMenu() {
  menuOpen.value = false;
}

function onCardClick() {
  emit('open', props.card);
}

function onKeydown(event: KeyboardEvent) {
  // Card-level keyboard support (N7): Enter opens, Alt+←/→ moves between
  // columns, Alt+↑/↓ reorders inside the column. Plain arrows stay free for
  // tab traversal / scrolling.
  if (event.key === 'Enter' && !event.altKey) {
    event.preventDefault();
    emit('open', props.card);
    return;
  }
  if (!event.altKey) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    emit('move', props.card.id, prevColumn());
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    emit('move', props.card.id, nextColumn());
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    emit('reorder', props.card.id, -1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    emit('reorder', props.card.id, 1);
  }
}

function prevColumn(): BoardColumnId {
  const ids = BOARD_COLUMNS.map((c) => c.id);
  return ids[Math.max(0, ids.indexOf(props.card.status) - 1)];
}

function nextColumn(): BoardColumnId {
  const ids = BOARD_COLUMNS.map((c) => c.id);
  return ids[Math.min(ids.length - 1, ids.indexOf(props.card.status) + 1)];
}

function onDragStart(event: DragEvent) {
  menuOpen.value = false;
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/x-board-card', props.card.id);
    event.dataTransfer.setData('text/plain', props.card.title);
    event.dataTransfer.effectAllowed = 'move';
  }
  emit('dragstart', props.card.id, event);
}

function moveTo(col: BoardColumnId) {
  menuOpen.value = false;
  emit('move', props.card.id, col);
}

function onDuplicate() {
  menuOpen.value = false;
  emit('duplicate', props.card.id);
}

function onRemove() {
  menuOpen.value = false;
  emit('remove', props.card.id);
}

onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu);
});
</script>

<template>
  <article
    class="board-card"
    :class="[`prio-${card.priority}`, { 'has-menu': menuOpen }]"
    :data-card-id="card.id"
    draggable="true"
    tabindex="0"
    :aria-label="`${card.title} — ${columnLabel(card.status)}`"
    @click="onCardClick"
    @keydown="onKeydown"
    @dragstart="onDragStart"
    @dragend="emit('dragend')"
  >
    <div class="card-top">
      <span class="card-title">{{ card.title || 'Untitled card' }}</span>
      <button
        class="card-menu-btn"
        aria-label="Card actions"
        :aria-expanded="menuOpen"
        title="Card actions"
        @click="toggleMenu"
        @keydown.stop
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    </div>

    <div class="card-meta">
      <span v-if="card.project" class="meta-chip" :title="card.project">{{ card.project }}</span>
      <span v-if="card.agent" class="meta-chip agent" :title="card.agent">{{ card.agent }}</span>
      <span class="meta-chip prio" :class="`p-${card.priority}`">{{ PRIORITY_LABEL[card.priority] }}</span>
      <span v-if="card.blockedBy" class="meta-chip blocked" :title="`Blocked by: ${card.blockedBy}`">blocked</span>
      <span v-if="card.session" class="meta-chip sess" title="Attached session">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 17l6-5-6-5M12 19h8" />
        </svg>
        session
      </span>
      <span v-if="card.links.length" class="meta-chip">{{ card.links.length }} link{{ card.links.length === 1 ? '' : 's' }}</span>
      <span class="meta-stamp">{{ fmtStamp(card.updatedAt) }}</span>
    </div>

    <p v-if="card.description" class="card-desc">{{ card.description }}</p>

    <div v-if="menuOpen" class="card-menu" role="menu" @click.stop>
      <div class="menu-label">Move to</div>
      <button
        v-for="col in otherColumns"
        :key="col.id"
        class="menu-item"
        role="menuitem"
        @click="moveTo(col.id)"
      >{{ col.label }}</button>
      <div class="menu-sep" />
      <button class="menu-item" role="menuitem" @click="onDuplicate">Duplicate</button>
      <button class="menu-item danger" role="menuitem" @click="onRemove">Delete…</button>
    </div>
  </article>
</template>

<style scoped>
.board-card {
  position: relative;
  padding: 0.375rem 0.5rem 0.375rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  cursor: pointer;
}

.board-card:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-color: var(--border-color, #e3dbcf);
}

.board-card:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
  border-color: var(--text-accent, #c2532f);
}

.board-card[draggable='true'] {
  user-select: none;
}

.card-top {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
}

.card-title {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 550;
  line-height: 1.3;
  letter-spacing: -0.005em;
  color: var(--text-primary, #2b2723);
  overflow-wrap: anywhere;
}

.card-menu-btn {
  flex: 0 0 auto;
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
  opacity: 0;
}

.board-card:hover .card-menu-btn,
.board-card:focus-within .card-menu-btn,
.board-card.has-menu .card-menu-btn {
  opacity: 1;
}

.card-menu-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.25rem;
}

.meta-chip {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  letter-spacing: 0.02em;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-radius: var(--radius-sm, 4px);
  padding: 0.0625rem 0.3rem;
  max-width: 9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-chip.prio {
  text-transform: uppercase;
}

.meta-chip.p-high {
  color: var(--bg-danger, #b3402e);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.meta-chip.blocked {
  color: var(--bg-danger, #b3402e);
}

.meta-chip.sess {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  color: var(--text-accent, #c2532f);
}

.meta-stamp {
  margin-left: auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.card-desc {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--text-secondary, #6b6259);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* "Move to" menu — also the touch / no-mouse path for moving cards. */
.card-menu {
  position: absolute;
  top: 1.625rem;
  right: 0.375rem;
  z-index: 30;
  min-width: 9.5rem;
  padding: 0.25rem;
  background: var(--bg-main, #fbf8f3);
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
}

.menu-label {
  padding: 0.25rem 0.5rem 0.125rem;
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.menu-item {
  display: block;
  width: 100%;
  min-height: 26px;
  padding: 0 0.5rem;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  font-family: inherit;
  font-size: 0.75rem;
  text-align: left;
  color: var(--text-primary, #2b2723);
  cursor: pointer;
}

.menu-item:hover,
.menu-item:focus-visible {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  outline: none;
}

.menu-item.danger {
  color: var(--bg-danger, #b3402e);
}

.menu-sep {
  height: 1px;
  margin: 0.25rem 0.375rem;
  background: var(--border-faint, rgba(43, 39, 35, 0.09));
}

@media (max-width: 767px) {
  .card-menu-btn {
    opacity: 1;
    width: 32px;
    height: 32px;
  }

  .menu-item {
    min-height: 40px;
    display: flex;
    align-items: center;
  }
}
</style>
