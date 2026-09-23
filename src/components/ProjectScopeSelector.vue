<script setup lang="ts">
// Global project scope selector — lives in the shell's scope bar (top of the
// main area, visible on every view). Value `all` plus the registry's project
// list; it writes through `uiStore.setActiveProject`, the single scope
// source, so sessions / Projects / (later) Board and Dashboard all follow the
// same selection without keeping private copies.
import { computed, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { useProjectsStore } from '../features/scope/registry';

const uiStore = useUiStore();
const projectsStore = useProjectsStore();

const projects = computed(() => projectsStore.projects);

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
  <label class="scope-selector">
    <svg
      class="scope-icon" viewBox="0 0 24 24" width="13" height="13" fill="none"
      stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    ><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
    <span class="scope-label">Project</span>
    <select v-model="value" class="scope-select" aria-label="Project scope">
      <option value="all">All</option>
      <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
  </label>
</template>

<style scoped>
.scope-selector {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}

.scope-icon {
  flex: 0 0 auto;
  color: var(--text-muted, #a39a8e);
}

.scope-label {
  flex: 0 0 auto;
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.scope-select {
  flex: 0 1 auto;
  min-width: 8rem;
  max-width: 16rem;
  height: 26px;
  padding: 0 0.375rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
}

.scope-select:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
}

@media (max-width: 800px) {
  .scope-selector {
    flex: 1;
  }

  .scope-select {
    flex: 1;
    max-width: none;
    min-height: 44px;
    font-size: 0.875rem;
  }
}
</style>
