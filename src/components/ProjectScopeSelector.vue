<script setup lang="ts">
import { computed, watch } from 'vue';
import UiSelect from './ui/UiSelect.vue';
import { useUiStore } from '../stores/ui';
import { useProjectsStore } from '../features/scope/registry';

const uiStore = useUiStore();
const projectsStore = useProjectsStore();

const projects = computed(() => projectsStore.projects);
const options = computed(() => [{ value: 'all', label: 'All projects' }, ...projects.value.map(p => ({ value: p.id, label: p.name }))]);

// If the persisted id no longer resolves (project removed elsewhere), fall
// back to 'all' — and persist the reset so the dead id doesn't linger.
const value = computed<string>({
  get: () => {
    const id = uiStore.activeProjectId;
    return id === 'all' || projects.value.some((p) => p.id === id) ? id : 'all';
  },
  set: (id) => {
    void uiStore.setActiveProject(id);
  },
});

watch(
  () => [uiStore.activeProjectId, projects.value.length],
  () => {
    const id = uiStore.activeProjectId;
    if (id !== 'all' && !projects.value.some((p) => p.id === id)) {
      void uiStore.setActiveProject('all');
    }
  }
);
</script>

<template>
  <UiSelect v-model="value" class="scope-selector" :options="options" label="Project scope">
    <template #icon>
      <svg class="select-folder" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </svg>
    </template>
  </UiSelect>
</template>

<style scoped>
.select-folder { flex-shrink: 0; color: var(--text-muted); }
</style>
