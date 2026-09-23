<script setup lang="ts">
import { computed } from 'vue';
import { useBoardStore } from '../../stores/board';
import { useUiStore } from '../../stores/ui';
import { useConfigStore } from '../../stores/config';
import { PRIORITIES } from './columns';

const board = useBoardStore();
const uiStore = useUiStore();
const configStore = useConfigStore();

const projects = computed(() => board.projectOptions);
const agents = computed(() => configStore.allAgentNames);

// The board obeys the global project scope (ui.ts → activeProjectId); the
// All button on the board is the one-click path back to the full board.
const scopedName = computed(() => uiStore.activeProject?.name ?? '');
const isAll = computed(() => uiStore.activeProjectId === 'all');

function showAll() {
  void uiStore.setActiveProject('all');
}
</script>

<template>
  <div class="board-filters" role="search">
    <span class="f-scope" title="Board scope follows the global project selector">
      <button
        class="f-scope-all"
        :class="{ active: isAll }"
        :aria-pressed="isAll"
        @click="showAll"
      >All</button>
      <span v-if="scopedName" class="f-scope-name" :title="`Scoped to ${scopedName}`">{{ scopedName }}</span>
    </span>
    <input
      v-model="board.filters.search"
      class="f-search"
      type="search"
      placeholder="Filter cards…"
      aria-label="Filter cards by text"
    />
    <select v-model="board.filters.project" class="f-select" aria-label="Filter by project">
      <option value="">All projects</option>
      <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
    </select>
    <select v-model="board.filters.agent" class="f-select" aria-label="Filter by agent">
      <option value="">All agents</option>
      <option v-for="a in agents" :key="a" :value="a">{{ a }}</option>
    </select>
    <select v-model="board.filters.priority" class="f-select" aria-label="Filter by priority">
      <option value="">Any priority</option>
      <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
    </select>
    <button
      v-if="board.isFiltering"
      class="f-clear"
      @click="board.clearFilters()"
    >Clear</button>
  </div>
</template>

<style scoped>
.board-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.f-scope {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 0 0 auto;
}

.f-scope-all {
  height: 28px;
  padding: 0 0.625rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.f-scope-all:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.f-scope-all.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  border-color: var(--text-accent, #c2532f);
  color: var(--text-accent, #c2532f);
}

.f-scope-all:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
}

.f-scope-name {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  max-width: 10rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.f-search {
  flex: 1 1 10rem;
  min-width: 8rem;
  height: 28px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.8125rem;
}

.f-select {
  height: 28px;
  padding: 0 0.375rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
  max-width: 11rem;
}

.f-search:focus-visible,
.f-select:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
  border-color: var(--text-accent, #c2532f);
}

.f-clear {
  height: 28px;
  padding: 0 0.625rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.f-clear:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

@media (max-width: 800px) {
  .f-search,
  .f-select,
  .f-clear,
  .f-scope-all {
    height: 44px;
  }
}
</style>
