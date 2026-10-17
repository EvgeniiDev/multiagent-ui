<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useBoardStore } from '../../stores/board';
import { useUiStore } from '../../stores/ui';
import { useConfigStore } from '../../stores/config';
import { PRIORITIES } from './columns';

const board = useBoardStore();
const uiStore = useUiStore();
const configStore = useConfigStore();

const projects = computed(() => board.projectOptions);
const agents = computed(() => configStore.allAgentNames);

// Same 800px breakpoint as the App.vue sidebar drawer: on phones the
// filter controls collapse behind a disclosure button (collapsed by
// default) to keep the kanban cards above the fold.
const isNarrow = ref(false);
let narrowMql: MediaQueryList | null = null;
function syncNarrow() {
  if (narrowMql) isNarrow.value = narrowMql.matches;
}

// The board obeys the global project scope (ui.ts → activeProjectId); the
// All button on the board is the one-click path back to the full board.
const scopedName = computed(() => uiStore.activeProject?.name ?? '');
const isAll = computed(() => uiStore.activeProjectId === 'all');

// Disclosure state for the narrow layout; collapsed by default.
const filtersOpen = ref(false);

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia('(max-width: 800px)');
    syncNarrow();
    narrowMql.addEventListener('change', syncNarrow);
  }
});
onBeforeUnmount(() => {
  if (narrowMql) {
    narrowMql.removeEventListener('change', syncNarrow);
    narrowMql = null;
  }
});

function showAll() {
  void uiStore.setActiveProject('all');
}
</script>

<template>
  <div class="board-filters" role="search">
    <span class="f-scope" title="Board scope follows the global project selector">
      <UiButton variant="secondary"
        class="f-scope-all"
        :aria-pressed="isAll"
        @click="showAll"
      >All</UiButton>
      <span v-if="scopedName" class="f-scope-name" :title="`Scoped to ${scopedName}`">{{ scopedName }}</span>
    </span>
    <UiButton variant="secondary"
      v-if="isNarrow"
      class="f-toggle"
      :aria-expanded="filtersOpen"
      :aria-pressed="filtersOpen"
      @click="filtersOpen = !filtersOpen"
    >Filters</UiButton>
    <template v-if="!isNarrow || filtersOpen">
      <input
        v-model="board.filters.search"
        class="ui-input f-search"
        type="search"
        placeholder="Filter cards…"
        aria-label="Filter cards by text"
      />
      <select v-model="board.filters.project" class="ui-input f-select" aria-label="Filter by project">
        <option value="">All projects</option>
        <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
      </select>
      <select v-model="board.filters.agent" class="ui-input f-select" aria-label="Filter by agent">
        <option value="">All agents</option>
        <option v-for="a in agents" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model="board.filters.priority" class="ui-input f-select" aria-label="Filter by priority">
        <option value="">Any priority</option>
        <option v-for="p in PRIORITIES" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
    </template>
    <UiButton variant="secondary"
      v-if="board.isFiltering"
      class="f-clear"
      @click="board.clearFilters()"
    >Clear</UiButton>
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
}

.f-select {
  max-width: 11rem;
}

@media (max-width: 800px) {
  /* Collapsed row is a single tap target line. */
  .f-toggle {
    flex: 1 1 100%;
  }
}
</style>
