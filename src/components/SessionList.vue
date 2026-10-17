<script setup lang="ts">
import { computed, ref } from 'vue';
import UiButton from './ui/UiButton.vue';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import { useProjectsStore } from '../features/scope/registry';
import type { SavedSession } from '../lib/types';
import type { SessionTab } from '../lib/sessionRuntime';

const emit = defineEmits<{
  resume: [session: SavedSession];
  activate: [tabId: string];
  delete: [sessionId: string];
  refresh: [];
  create: [];
}>();

const sessionStore = useSessionStore();
const uiStore = useUiStore();
const projectsStore = useProjectsStore();

// The sidebar lists every agent's sessions merged, newest first — the
// per-row agent chip carries the distinction. On top of that the global
// project scope applies: with a project selected only sessions whose cwd
// lies inside its path show; 'all' is unfiltered.
const showArchived = ref(false);
const actionBusy = ref(false);
const actionError = ref('');
const sessions = computed(() =>
  projectsStore.sessionsOfProject(showArchived.value ? sessionStore.archivedSessions : sessionStore.visibleSessions)
);

// 'all' is the only mode where a session outside every project is visible —
// those rows get an "unassigned" tag so the distinction stays readable.
const showUnassigned = computed(() => uiStore.activeProjectId === 'all');
function isUnassigned(session: SavedSession): boolean {
  return !projectsStore.projectIdForCwd(session.cwd);
}

const activeSessionId = computed(() => sessionStore.currentSession?.id ?? '');
// Include descriptors so connecting and failed restores retain their status.
const openRuntimes = computed(() => new Map(sessionStore.openTabs.map(runtime => {
  const target = runtime.session ?? runtime.descriptor;
  return [JSON.stringify([target?.agentName, target?.sessionId]), runtime];
})));
function sessionStatus(runtime?: SessionTab, session?: SavedSession) {
  if (!runtime) return session?.supportsLoadSession ? null : { kind: 'unavailable', label: 'Cannot reopen', detail: 'This agent does not support reopening saved sessions.' };
  if (runtime.pendingPermission) return { kind: 'permission', label: 'Waiting for permission' };
  if (runtime.error) return { kind: 'error', label: 'Error', detail: runtime.error };
  if (runtime.isConnecting) return { kind: 'working', label: 'Connecting' };
  if (runtime.isLoading && runtime.isConnected) return { kind: 'working', label: 'Working' };
  if (runtime.unread) return { kind: 'unread', label: 'Unread reply' };
  if (!runtime.isConnected) return { kind: 'disconnected', label: 'Disconnected' };
  return { kind: 'open', label: 'Open' };
}
const rows = computed(() => {
  const savedRows = sessions.value.map(session => {
    const runtime = openRuntimes.value.get(JSON.stringify([session.agentName, session.sessionId]));
    return { session, runtime, status: sessionStatus(runtime, session), transient: false };
  });
  // session/new can still be pending or failed before a saved session exists.
  const transientRows = (showArchived.value ? [] : sessionStore.openTabs)
    .filter(runtime => !runtime.session && !runtime.descriptor)
    .map(runtime => ({
      session: {
        id: runtime.id, sessionId: '', agentName: runtime.agentName,
        title: 'New session', cwd: '', lastUpdated: 0,
      } as SavedSession,
      runtime, status: sessionStatus(runtime), transient: true,
    }));
  return [...savedRows, ...transientRows];
});
function openRow(session: SavedSession, runtime: SessionTab | undefined, transient: boolean) {
  if (!runtime && !session.supportsLoadSession) {
    actionError.value = 'This agent does not support reopening saved sessions.';
    return;
  }
  if (transient && runtime) emit('activate', runtime.id);
  else handleResume(session);
}

const isSyncing = computed(() => sessionStore.isSyncingSessions);
const syncError = computed(() => sessionStore.syncError);
// Hidden only once EVERY configured agent said it has no `session/list` —
// before the first attempt the capability is unknown, and clicking is how we
// find out.
const canListAgentSessions = computed(() => !sessionStore.sessionListUnsupported);

/** Compact stamp: today -> HH:MM, this year -> "12 сен", else ISO date. */
function formatStamp(timestamp: number): string {
  if (!timestamp) return '—';
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

function handleRefresh() {
  if (isSyncing.value) return;
  emit('refresh');
}

async function setArchived(session: SavedSession, archived: boolean) {
  if (actionBusy.value) return;
  actionBusy.value = true;
  actionError.value = '';
  try {
    if (archived) await sessionStore.archiveSession(session.id);
    else await sessionStore.restoreArchivedSession(session.id);
  } catch (error) {
    actionError.value = `Could not ${archived ? 'archive' : 'restore'} session: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    actionBusy.value = false;
  }
}
</script>

<template>
  <div class="session-list">
    <div class="list-head">
      <span class="list-label">{{ showArchived ? 'Archived' : 'Sessions' }}</span>
      <span class="list-count">{{ rows.length || '' }}</span>
      <UiButton variant="ghost" icon :aria-label="showArchived ? 'Show active sessions' : 'Show archived sessions'" :title="showArchived ? 'Back to sessions' : 'Archive'" :aria-pressed="showArchived" @click="showArchived = !showArchived">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8v12h16V8M3 4h18v4H3zM9 12h6" /></svg>
      </UiButton>
      <UiButton v-if="!showArchived" class="list-create" variant="ghost" icon aria-label="New session" title="New session" @click="emit('create')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </UiButton>
      <UiButton
        v-if="canListAgentSessions"
        variant="ghost" icon
        class="list-refresh"
        :class="{ busy: isSyncing }"
        :disabled="isSyncing"
        @click="handleRefresh"
        :title="isSyncing ? 'Loading sessions from agents…' : 'Load sessions from all agents'"
        aria-label="Load sessions from all agents"
      >⟳</UiButton>
    </div>

    <div v-if="actionError" class="sync-note error" role="alert">{{ actionError }}</div>
    <div v-if="syncError" class="sync-note error" :title="syncError">Couldn&rsquo;t load agent sessions</div>
    <div v-else-if="sessionStore.sessionListUnsupported" class="sync-note">
      None of the configured agents can list sessions.
    </div>

    <div v-if="rows.length === 0" class="empty-state">
      {{ showArchived ? 'No archived sessions.' : 'No sessions yet — start a new session.' }}
    </div>

    <ul v-else>
      <li
        v-for="{ session, runtime, status, transient } in rows"
        :key="session.id"
        :data-session-id="session.id"
        class="session-row"
        :class="{ active: runtime ? runtime.id === sessionStore.activeTabId : session.id === activeSessionId }"
        :title="`${session.title}\n${session.agentName} · ${session.cwd || '—'}`"
        tabindex="0"
        role="link"
        @keydown.enter.self="openRow(session, runtime, transient)"
        @keydown.space.self.prevent="openRow(session, runtime, transient)"
        @click="openRow(session, runtime, transient)"
      >
        <div class="row-content">
          <div class="row-heading">
            <span
              v-if="runtime"
              class="row-open"
              title="Open in a tab"
              aria-hidden="true"
            ></span>
            <span class="row-title">{{ session.title }}</span>
          </div>
          <div class="row-meta">
            <span class="row-agent" :title="session.agentName">{{ session.agentName }}</span>
            <span
              v-if="showUnassigned && isUnassigned(session)"
              class="row-tag"
              title="Not inside any registered project"
            >unassigned</span>
            <span v-if="status" class="row-status" :class="status.kind" :title="status.detail || status.label">{{ status.label }}</span>
            <span class="row-stamp">{{ formatStamp(session.lastUpdated) }}</span>
          </div>
        </div>
        <UiButton
          v-if="showArchived"
          variant="ghost" icon size="xs"
          aria-label="Restore session" title="Restore session to history"
          :disabled="actionBusy"
          @click.stop="setArchived(session, false)"
        ><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10a8 8 0 111 8M4 4v6h6" /></svg></UiButton>
        <UiButton
          v-else
          class="row-close"
          variant="ghost" icon size="xs"
          :aria-label="transient ? 'Close session' : 'Archive session'"
          :title="transient ? 'Close session' : 'Archive session (keep history)'"
          :disabled="actionBusy"
          @click.stop="transient && runtime ? sessionStore.closeTab(runtime.id) : setArchived(session, true)"
        ><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l16 16M20 4L4 20" /></svg></UiButton>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.session-list {
  padding: 0;
}

.list-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0 0.375rem 0.375rem;
}

.list-label {
  flex: 1;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

/* Pull the agents' session inventories (`session/list`) into this list. */
.list-refresh { flex: 0 0 auto; }
.list-create { display: none; }

.list-refresh.busy {
  animation: session-list-spin 0.9s linear infinite;
}

@keyframes session-list-spin {
  to {
    transform: rotate(360deg);
  }
}

.sync-note {
  padding: 0 0.375rem 0.375rem;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.sync-note.error {
  color: var(--bg-danger, #b3402e);
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

/* Title first; agent and timestamp share the quieter line below. */
.session-row {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-height: 44px;
  padding: 0.375rem 0.375rem 0.375rem 0.5rem;
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
}

.row-content {
  flex: 1;
  min-width: 0;
}

.row-heading,
.row-meta {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
}

.row-meta {
  margin-top: 0.25rem;
}

.session-row:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.session-row.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

/* Keep agent names compact so metadata fits narrow sidebars. */
.row-agent {
  flex: 0 1 auto;
  max-width: 7.5em;
  padding: 0 0.3rem;
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-hover, #efe9e0);
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  line-height: 1.6;
  letter-spacing: 0.02em;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Small accent tick marking sessions already open in a tab. */
.row-open {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-accent, #b04a28);
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

/* Small muted tag marking sessions outside every project (All mode only). */
.row-tag {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-sm, 4px);
  padding: 0 0.25rem;
  line-height: 1.5;
}

.row-stamp {
  flex: 0 0 auto;
  margin-left: auto;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
}

.row-close { flex: 0 0 auto; opacity: 0; }
.session-row:hover .row-close,
.session-row:focus-within .row-close,
.session-row.active .row-close { opacity: 1; }
.session-row:focus-visible { outline: 2px solid var(--text-accent); outline-offset: -2px; }

.row-status {
  font-size: 0.625rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-status.working, .row-status.unread, .row-status.permission { color: var(--text-accent); }
.row-status.error { color: var(--bg-danger); }
.row-status.working::before {
  content: '';
  display: inline-block;
  width: 8px; height: 8px;
  margin-right: 4px;
  border: 1px solid var(--border-faint);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: session-list-spin 0.9s linear infinite;
}
@media (max-width: 800px) {
  .list-create { display: inline-flex; }
  .session-row { min-height: 72px; padding: 0.625rem 0.5rem; }
  .row-title { font-size: 0.9375rem; white-space: normal; overflow-wrap: anywhere; }
  .row-agent, .row-status, .row-stamp { font-size: 0.6875rem; }
  .row-tag { display: none; }

  .row-close { display: inline-flex; opacity: 1; }
}
</style>
