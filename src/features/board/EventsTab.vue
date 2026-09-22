<script setup lang="ts">
import { computed, ref } from 'vue';
import { useActivityStore, type ActivityKind } from '../../stores/activity';
import { fmtTime } from './format';

const activity = useActivityStore();

// Live stream: the ledger's `recent(n)` is already newest-first. The window
// is capped at 200 rows (N4) — enough signal without a long render list.
const WINDOW = 200;

const kindFilter = ref<'' | ActivityKind>('');
const agentFilter = ref('');

const latest = computed(() => activity.recent(WINDOW));

const kindOptions = computed(() =>
  [...new Set(latest.value.map((e) => e.kind))].sort()
);

const agentOptions = computed(() =>
  [...new Set(latest.value.map((e) => e.agentName))].sort()
);

const rows = computed(() =>
  latest.value.filter(
    (e) =>
      (!kindFilter.value || e.kind === kindFilter.value) &&
      (!agentFilter.value || e.agentName === agentFilter.value)
  )
);

const BAD_KINDS = new Set<ActivityKind>(['error', 'lock']);
</script>

<template>
  <div class="events-tab">
    <div class="events-bar">
      <select v-model="kindFilter" class="ev-select" aria-label="Filter events by kind">
        <option value="">All kinds</option>
        <option v-for="k in kindOptions" :key="k" :value="k">{{ k }}</option>
      </select>
      <select v-model="agentFilter" class="ev-select" aria-label="Filter events by agent">
        <option value="">All agents</option>
        <option v-for="a in agentOptions" :key="a" :value="a">{{ a }}</option>
      </select>
      <span class="ev-count mono" aria-live="polite">{{ rows.length }} events</span>
    </div>

    <div v-if="rows.length === 0" class="tab-empty" aria-live="polite">
      No events yet. Session starts, turns, tool calls and card moves stream
      in here as they happen.
    </div>

    <ul v-else class="event-list" aria-label="Recent events, newest first">
      <li v-for="e in rows" :key="e.id" class="event-row">
        <span class="kind mono" :class="{ bad: BAD_KINDS.has(e.kind) }">{{ e.kind }}</span>
        <span class="agent mono">{{ e.agentName }}</span>
        <span class="sess" :title="e.sessionId">{{ e.title || e.sessionId || '' }}</span>
        <span class="detail" :title="e.detail">{{ e.detail || '' }}</span>
        <span class="time mono">{{ fmtTime(e.at) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.events-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.events-bar {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.ev-select {
  height: 28px;
  padding: 0 0.375rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
  max-width: 12rem;
}

.ev-select:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
  border-color: var(--text-accent, #c2532f);
}

.ev-count {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.tab-empty {
  padding: 2rem;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
  text-align: center;
}

.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.event-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 26px;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  font-size: 0.75rem;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.kind {
  flex: 0 0 auto;
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-radius: var(--radius-sm, 4px);
  padding: 0.0625rem 0.3rem;
}

.kind.bad {
  color: var(--bg-danger, #b3402e);
}

.agent {
  flex: 0 0 auto;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
}

.sess {
  flex: 0 1 auto;
  max-width: 24%;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  flex: 0 0 auto;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
}

@media (max-width: 800px) {
  .ev-select {
    height: 44px;
  }

  .event-row {
    flex-wrap: wrap;
    padding: 0.375rem 0.75rem;
    min-height: 40px;
    row-gap: 0.125rem;
  }

  .detail {
    flex-basis: 100%;
  }
}
</style>
