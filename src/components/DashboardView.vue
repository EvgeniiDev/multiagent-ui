<script setup lang="ts">
// Placeholder for the Dashboard view (F5 in docs/control-center-requirements.md).
// Reads the activity store (src/stores/activity.ts) — see its header for the API.
import { useActivityStore } from '../stores/activity';

const activity = useActivityStore();
const { from, to } = activity.dayRange(7);
const totals = activity.totalUsage(from, to);
</script>

<template>
  <div class="view-pane">
    <header class="pane-head">
      <h2>Dashboard</h2>
      <span class="pane-note">
        last 7 days · {{ totals.tokens }} tokens · {{ totals.turns }} turns
      </span>
    </header>
    <div class="pane-body">
      <p class="pane-empty">Charts and limits are not built yet.</p>
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
