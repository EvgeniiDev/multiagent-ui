<script setup lang="ts">
// Project detail pane — the right-hand column on wide viewports, inlined
// under the clicked row inside the list on narrow ones. Shows the metrics
// roll-up for the selected range, the per-project session list, and the
// project-scoped "New session here" action. An × dismisses the pane (the
// selection itself is cleared by the parent).
import type { SavedSession } from '../../lib/types';
import type { ProjectRow } from './types';
import { formatStamp, relative, compactNumber } from './format';

defineProps<{
  project: ProjectRow;
  sessions: SavedSession[];
  range: 7 | 30 | 0;
}>();

const emit = defineEmits<{
  close: [];
  resume: [session: SavedSession];
  newSession: [project: ProjectRow];
}>();
</script>

<template>
  <section class="project-detail">
    <header class="detail-head">
      <div class="detail-title">
        <h3>{{ project.name }}</h3>
        <p class="detail-path mono">{{ project.cwd }}</p>
      </div>
      <div class="detail-actions">
        <button class="action" @click="emit('newSession', project)">New session here</button>
        <button
          class="detail-close"
          type="button"
          aria-label="Close project detail"
          title="Close"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
    </header>

    <div class="detail-metrics">
      <span class="metric">
        <span class="metric-label">sessions</span>
        <span class="metric-value mono">{{ project.sessions }}</span>
      </span>
      <span class="metric">
        <span class="metric-label">last activity</span>
        <span class="metric-value mono">{{ relative(project.lastActivity) }}</span>
      </span>
      <span class="metric">
        <span class="metric-label">tokens ({{ range ? range + 'd' : 'all' }})</span>
        <span class="metric-value mono">{{ compactNumber(project.tokens) }}</span>
      </span>
      <span class="metric">
        <span class="metric-label">turns</span>
        <span class="metric-value mono">{{ project.turns }}</span>
      </span>
      <span v-if="project.cost" class="metric">
        <span class="metric-label">cost</span>
        <span class="metric-value mono">{{ project.cost.toFixed(2) }}</span>
      </span>
    </div>

    <h4 class="detail-sub">Sessions</h4>
    <ul class="detail-sessions">
      <li
        v-for="session in sessions"
        :key="session.id"
        class="detail-session"
        @click="emit('resume', session)"
      >
        <span class="session-title" :title="session.title">{{ session.title }}</span>
        <span class="session-agent">{{ session.agentName }}</span>
        <span class="session-stamp">{{ formatStamp(session.lastUpdated) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.project-detail {
  padding-top: 0.25rem;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.detail-title {
  min-width: 0;
}

.detail-head h3 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.detail-path {
  margin: 0.125rem 0 0;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  overflow-wrap: anywhere;
}

.detail-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.action {
  height: 28px;
  padding: 0 0.75rem;
  border: 1px solid var(--bg-primary, #c2532f);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-accent, #c2532f);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.action:hover {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.detail-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  cursor: pointer;
}

.detail-close:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.detail-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  margin: 0.625rem 0 0;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.metric-label {
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.metric-value {
  font-size: 0.8125rem;
  color: var(--text-primary, #2b2723);
}

.detail-sub {
  margin: 0.875rem 0 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.detail-sessions {
  list-style: none;
  margin: 0;
  padding: 0;
}

.detail-session {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 28px;
  padding: 0 0.375rem;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
}

.detail-session:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.session-title {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-agent {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.session-stamp {
  flex: 0 0 auto;
  min-width: 3.5rem;
  text-align: right;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

@media (max-width: 800px) {
  .detail-session {
    min-height: 44px;
  }

  .action {
    min-height: 44px;
  }

  .detail-close {
    width: 44px;
    height: 44px;
  }
}
</style>
