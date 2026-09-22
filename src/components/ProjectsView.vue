<script setup lang="ts">
// Placeholder for the Projects view (F2 in docs/control-center-requirements.md).
// Owned by the shell workstream; the projects feature fills this in.
import { useSessionStore } from '../stores/session';

const sessionStore = useSessionStore();
</script>

<template>
  <div class="view-pane">
    <header class="pane-head">
      <h2>Projects</h2>
      <span class="pane-note">{{ sessionStore.savedSessions.length }} sessions known</span>
    </header>
    <div class="pane-body">
      <p class="pane-empty">Projects are derived from session working directories. Not built yet.</p>
    </div>
  </div>
</template>

<style scoped>
.view-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.pane-head h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.pane-note {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.pane-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.75rem 1rem;
}

.pane-empty {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
}
</style>
