<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore } from '../stores/session';
import type { SavedSession } from '../lib/types';

const emit = defineEmits<{
  resume: [session: SavedSession];
  delete: [sessionId: string];
}>();

const sessionStore = useSessionStore();

// Only show sessions that can be resumed (agent supports loadSession)
const sessions = computed(() =>
  [...sessionStore.resumableSessions].sort((a, b) => b.lastUpdated - a.lastUpdated)
);

const activeSessionId = computed(() => sessionStore.currentSession?.id ?? '');

/** Compact stamp: today -> HH:MM, this year -> "12 сен", else ISO date. */
function formatStamp(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getDate()} ${months[d.getMonth()]}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function handleResume(session: SavedSession) {
  emit('resume', session);
}

function handleDelete(sessionId: string, event: Event) {
  event.stopPropagation();
  if (confirm('Delete this session?')) {
    emit('delete', sessionId);
  }
}
</script>

<template>
  <div class="session-list">
    <div class="list-head">
      <span class="list-label">Sessions</span>
      <span class="list-count">{{ sessions.length || '' }}</span>
    </div>

    <div v-if="sessions.length === 0" class="empty-state">
      Nothing here yet — start a session above.
    </div>

    <ul v-else>
      <li
        v-for="session in sessions"
        :key="session.id"
        class="session-row"
        :class="{ active: session.id === activeSessionId }"
        :title="`${session.title}\n${session.agentName} · ${session.cwd || '—'}`"
        @click="handleResume(session)"
      >
        <span class="row-title">{{ session.title }}</span>
        <span class="row-meta">{{ session.agentName }}</span>
        <span class="row-stamp">{{ formatStamp(session.lastUpdated) }}</span>
        <button
          class="row-delete"
          @click="(e) => handleDelete(session.id, e)"
          title="Delete session"
          aria-label="Delete session"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.session-list {
  padding: 0.625rem 0.5rem;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.375rem 0.375rem;
}

.list-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.list-count {
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
}

.empty-state {
  padding: 0.5rem 0.375rem 0.25rem;
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--text-muted, #a39a8e);
}

ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* One dense line per session: title on the left, agent · folder and the
 * timestamp right-aligned. No card chrome — a hover tint carries the state. */
.session-row {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-height: 26px;
  padding: 0 0.375rem 0 0.5rem;
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
}

.session-row:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.session-row.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.row-title {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 1.2;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-row.active .row-title {
  font-weight: 600;
}

/* Agent name collapses first when the sidebar is narrow. */
.row-meta {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-stamp {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
}

.row-delete {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}

.session-row:hover .row-delete,
.session-row.active .row-delete {
  opacity: 1;
}

.row-delete:hover {
  background: var(--bg-danger, #b3402e);
  color: #fff;
}
</style>
