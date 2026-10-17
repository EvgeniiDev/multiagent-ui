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
    <svg class="scope-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    ><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
    <select v-model="value" class="ui-input scope-select" aria-label="Project scope">
      <option value="all">All projects</option>
      <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
  </label>
</template>

<style scoped>
.scope-selector { position: relative; display: block; min-width: 0; width: 100%; }
.scope-icon { position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
.scope-select { width: 100%; min-width: 0; min-height: 44px; padding-left: 2.375rem; font-size: 0.8125rem; background-color: var(--bg-main); }
</style>
