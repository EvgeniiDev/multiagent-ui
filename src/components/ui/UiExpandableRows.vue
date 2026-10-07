<script setup lang="ts" generic="T">
import { computed, ref } from 'vue';
import UiButton from './UiButton.vue';

const props = withDefaults(defineProps<{
  rows: T[];
  controlsId: string;
  limit?: number;
  toggleTestId?: string;
  orderedByRank?: boolean;
}>(), { limit: 20, orderedByRank: true });

const expanded = ref(false);
const visibleRows = computed(() => expanded.value ? props.rows : props.rows.slice(0, props.limit));
</script>

<template>
  <slot :rows="visibleRows" />
  <UiButton
    v-if="rows.length > limit"
    class="expandable-toggle"
    :data-testid="toggleTestId"
    :aria-controls="controlsId"
    :aria-expanded="expanded"
    @click="expanded = !expanded"
  >{{ expanded ? `Show ${orderedByRank ? 'top' : 'first'} ${limit}` : `Show all (${rows.length - limit} more)` }}</UiButton>
</template>

<style scoped>
.expandable-toggle {
  margin-top: 0.5rem;
  align-self: flex-start;
}
</style>
