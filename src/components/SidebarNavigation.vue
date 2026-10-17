<script setup lang="ts">
import { VIEWS, type ViewId } from '../stores/ui';
import UiButton from './ui/UiButton.vue';

defineProps<{ activeView: ViewId; ready: boolean }>();
defineEmits<{ navigate: [view: ViewId] }>();
</script>

<template>
  <nav class="drawer-view-nav" aria-label="Main views">
    <UiButton v-for="view in VIEWS" :key="view.id" variant="ghost" layout="stacked"
      :title="`${view.label} (${view.key})`" :aria-label="view.label"
      :aria-current="ready && activeView === view.id ? 'page' : undefined"
      @click="$emit('navigate', view.id)"
    >
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="view.id === 'chat'" d="M21 11.5a8.4 8.4 0 01-9 8.4 8.9 8.9 0 01-3.8-.9L3 20l1.1-3.3A8.4 8.4 0 013 11.5 8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z" />
        <path v-else-if="view.id === 'projects'" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        <path v-else-if="view.id === 'board'" d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z" />
        <template v-else><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3-2" /></template>
      </svg>
      <span>{{ view.label }}</span>
    </UiButton>
  </nav>
</template>

<style scoped>
.drawer-view-nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.25rem; padding: 0.5rem 0.75rem 0; }
</style>
