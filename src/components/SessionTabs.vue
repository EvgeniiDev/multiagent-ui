<script setup lang="ts">
import { computed } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiActionRow from './ui/UiActionRow.vue';
import { useSessionStore } from '../stores/session';
import type { SessionTab } from '../lib/sessionRuntime';

// IDE-style tab strip over the chat area: one tab per open session, ordered
// by open time. A tab stays live in the background — the badges surface what
// needs attention without switching: spinner while a turn/connect runs, "!"
// for a pending permission or a dead transport, a dot for unread output.
const sessionStore = useSessionStore();

const tabs = computed(() => sessionStore.openTabs);
const activeId = computed(() => sessionStore.activeTabId);

// The agent suffix only earns its pixels when tabs span several agents —
// a single-agent strip would print the same label on every row.
const severalAgents = computed(() => {
  const names = new Set(tabs.value.map((t) => agent(t)));
  return names.size > 1;
});

function title(rt: SessionTab): string {
  const s = rt.session ?? rt.descriptor;
  return s?.title || s?.cwd || 'New session';
}

function agent(rt: SessionTab): string {
  return rt.session?.agentName ?? rt.descriptor?.agentName ?? rt.agentName;
}

function tooltip(rt: SessionTab): string {
  const s = rt.session ?? rt.descriptor;
  const lines = [s?.title || 'New session', `${agent(rt)}${s?.cwd ? ` · ${s.cwd}` : ''}`];
  if (rt.error) lines.push(rt.error);
  else if (rt.pendingPermission) lines.push('Waiting for permission');
  else if (!rt.isConnected && !rt.isConnecting) lines.push('Disconnected — click to reconnect');
  else if (rt.turnIssue && !rt.isLoading && !rt.isConnecting) lines.push(rt.turnIssue === 'cancelled' ? 'Cancelled' : 'Error — the agent turn failed');
  else if (rt.turnCompleted && !rt.isLoading && !rt.isConnecting) lines.push('Completed — the agent finished its turn');
  return lines.filter(Boolean).join('\n');
}

function activate(rt: SessionTab) {
  sessionStore.activateTab(rt.id);
  // A dead tab should come back on click, not just render its error. A tab
  // whose first resume failed carries its target in `descriptor`.
  const s = rt.session ?? rt.descriptor;
  if (
    s &&
    !rt.isConnected &&
    !rt.isConnecting &&
    !rt.isLoading &&
    s.supportsLoadSession
  ) {
    void rt.tryReconnect();
  }
}

function close(rt: SessionTab, e: Event) {
  e.stopPropagation();
  void sessionStore.closeTab(rt.id);
}

function onMiddleClick(rt: SessionTab, e: MouseEvent) {
  if (e.button === 1) {
    e.preventDefault();
    void sessionStore.closeTab(rt.id);
  }
}
</script>

<template>
  <div class="tab-strip" role="tablist" aria-label="Open sessions">
    <UiActionRow
      variant="tab"
      :selected="rt.id === activeId"
      v-for="rt in tabs"
      :key="rt.id"
      class="session-tab"
    >
      <UiButton variant="session-tab" class="tab"
        :class="{
          active: rt.id === activeId,
          disconnected: !rt.isConnected && !rt.isConnecting,
        }"
        role="tab"
        :aria-selected="rt.id === activeId"
        :title="tooltip(rt)"
        @click="activate(rt)"
        @mousedown="onMiddleClick(rt, $event)"
      >
        <!-- status: working > permission > error > completed > unread -->
        <span
          v-if="rt.isConnecting || (rt.isLoading && rt.isConnected)"
          class="tab-spin"
          aria-hidden="true"
        ></span>
        <span
          v-else-if="rt.pendingPermission"
          class="tab-badge perm"
          title="Waiting for permission"
        >!</span>
        <span
          v-else-if="rt.error"
          class="tab-badge err"
          title="Error"
        >!</span>
        <span
          v-else-if="rt.turnIssue"
          class="tab-badge err"
          :title="rt.turnIssue === 'cancelled' ? 'Cancelled' : 'Error — the agent turn failed'"
          :aria-label="rt.turnIssue === 'cancelled' ? 'Cancelled' : 'Error — the agent turn failed'"
        >{{ rt.turnIssue === 'cancelled' ? '×' : '!' }}</span>
        <span
          v-else-if="rt.turnCompleted && rt.isConnected"
          class="tab-completed"
          title="Completed — the agent finished its turn"
          aria-label="Completed — the agent finished its turn"
        >✓</span>
        <span
          v-else-if="rt.unread"
          class="tab-dot"
          aria-hidden="true"
        ></span>
        <span
          v-else-if="!rt.isConnected && !rt.isConnecting"
          class="tab-dot dead"
          title="Disconnected"
        ></span>

        <span class="tab-title">{{ title(rt) }}</span>
        <span v-if="severalAgents" class="tab-agent">{{ agent(rt) }}</span>

      </UiButton>
      <template #actions>
        <UiButton
          class="tab-close" :reveal="rt.id !== activeId"
          variant="ghost"
          size="xs"
          icon
          title="Close tab (the session stays in the list)"
          aria-label="Close tab"
          @click="close(rt, $event)"
        >
          <svg class="tab-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </UiButton>
      </template>
    </UiActionRow>
  </div>
</template>

<style scoped>
.session-tab { flex: 0 0 auto; min-width: 0; max-width: 220px; }
/* Pure scroll container: the bar chrome (background, border, padding) lives
 * on .session-navigation in App.vue so the "+" menu and the tabs share one
 * strip. */
.tab-strip {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.tab { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 220px; user-select: none; white-space: nowrap; }

.tab.disconnected:not(.active) .tab-title {
  opacity: 0.7;
}

.tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.tab.active .tab-title {
  font-weight: 600;
}

.tab-agent {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  color: var(--text-muted);
}

.tab-spin {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-faint);
  border-top-color: var(--text-accent);
  border-radius: 50%;
  animation: tab-spin 0.8s linear infinite;
}

@keyframes tab-spin {
  to { transform: rotate(360deg); }
}

.tab-completed {
  flex: 0 0 auto;
  color: var(--bg-success);
}

.tab-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-accent);
}

.tab-dot.dead {
  background: var(--border-faint);
}

.tab-badge {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1;
}

.tab-badge.perm {
  background: var(--bg-primary);
  color: var(--text-on-accent);
}

.tab-badge.err {
  background: var(--bg-danger);
  color: var(--text-on-accent);
}
.tab-close { flex: 0 0 auto; }

.tab-close-icon {
  width: 14px;
  height: 14px;
}

@media (max-width: 800px), (pointer: coarse) {

  .tab-close-icon {
    width: 20px;
    height: 20px;
  }
}
</style>
