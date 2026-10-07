<script setup lang="ts" generic="T">
import { computed, ref } from 'vue';
import UiButton from './UiButton.vue';

const props = withDefaults(defineProps<{
  rows: T[];
  controlsId: string;
  limit?: number;
  toggleTestId?: string;
  orderedByRank?: boolean;
  showCount?: boolean;
  collapsedLabel?: string;
}>(), { limit: 20, orderedByRank: true });

const expanded = ref(false);
const visibleRows = computed(() => expanded.value ? props.rows : props.rows.slice(0, props.limit));
</script>

<template>
  <div v-if="showCount || rows.length > limit" class="row-controls">
    <span v-if="showCount" class="row-count" role="status">Showing {{ visibleRows.length }} of {{ rows.length.toLocaleString('en-US') }}</span>
    <UiButton v-if="rows.length > limit" variant="ghost" size="xs"
      :data-testid="toggleTestId" :aria-controls="controlsId" :aria-expanded="expanded"
      @click="expanded = !expanded"
    >{{ expanded ? (collapsedLabel || `Show ${orderedByRank ? 'top' : 'first'} ${limit}`) : `Show all (${rows.length - limit} more)` }}</UiButton>
  </div>
  <slot :rows="visibleRows" />
</template>

<style scoped>
.row-controls { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin: .5rem 0; flex-wrap: wrap; }
.row-count { font-size: .6875rem; color: var(--text-muted); }
.row-controls > :last-child { margin-left: auto; }
</style>
