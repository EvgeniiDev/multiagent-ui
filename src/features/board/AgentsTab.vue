<script setup lang="ts">
import { computed } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useSessionStore } from '../../stores/session';
import { useActivityStore, type ActivityEntry } from '../../stores/activity';
import { restrictedTransports } from '../../lib/platform';
import { fmtStamp } from './format';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const activity = useActivityStore();

const webOnly = restrictedTransports();

interface AgentRow {
  name: string;
  transport: string;
  reachable: string;
  live: boolean;
  busy: boolean;
  sessionTitle: string;
  lastAt: number | null;
  lastText: string;
  locks: number;
  errors: number;
}

const rows = computed<AgentRow[]>(() => {
  const { from, to } = activity.dayRange(1);
  const dayEntries = activity.entriesInRange(from, to);
  return configStore.allAgentNames.map((name) => {
    const kind = configStore.getAgentTransportKind(name);
    const isRemote = kind === 'websocket' || kind === 'http';
    const live =
      sessionStore.isConnected && sessionStore.currentSession?.agentName === name;
    const mine = activity.entries.filter((e) => e.agentName === name);
    const last: ActivityEntry | undefined = mine[mine.length - 1];
    const day = dayEntries.filter((e) => e.agentName === name);
    return {
      name,
      transport: kind === 'websocket' ? 'ws' : kind,
      reachable: isRemote ? 'remote' : webOnly ? 'local · n/a on web' : 'local',
      live,
      busy: live && sessionStore.isLoading,
      sessionTitle: live ? sessionStore.currentSession?.title ?? '' : '',
      lastAt: last?.at ?? null,
      lastText: last
        ? [last.kind, last.title, last.detail].filter(Boolean).join(' · ')
        : '',
      locks: day.filter((e) => e.kind === 'lock').length,
      errors: day.filter((e) => e.kind === 'error').length,
    };
  });
});
</script>

<template>
  <div class="agents-tab">
    <div v-if="rows.length === 0" class="tab-empty" aria-live="polite">
      No agents configured. Add agents in Settings to see live status here.
    </div>

    <ul v-else class="agent-list">
      <li v-for="row in rows" :key="row.name" class="agent-row">
        <div class="agent-line">
          <span class="dot" :class="{ live: row.live }" aria-hidden="true" />
          <span class="agent-name">{{ row.name }}</span>
          <span class="chip mono">{{ row.transport }}</span>
          <span class="chip mono reach" :class="{ live: row.live }">
            {{ row.live ? 'connected' : row.reachable }}
          </span>
          <span v-if="row.busy" class="chip mono busy">turn in flight</span>
          <span v-else-if="row.live" class="chip mono">idle</span>
          <span v-if="row.sessionTitle" class="sess mono" :title="row.sessionTitle">
            {{ row.sessionTitle }}
          </span>
          <span class="spacer" />
          <span
            class="chip mono"
            :class="{ bad: row.locks > 0 }"
            :title="`${row.locks} lock(s) in the last 24h`"
          >{{ row.locks }}L</span>
          <span
            class="chip mono"
            :class="{ bad: row.errors > 0 }"
            :title="`${row.errors} error(s) in the last 24h`"
          >{{ row.errors }}E</span>
        </div>
        <div class="agent-sub">
          <span v-if="row.lastAt" class="mono stamp">{{ fmtStamp(row.lastAt) }}</span>
          <span class="last-text" :title="row.lastText">
            {{ row.lastText || 'no activity recorded' }}
          </span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.agents-tab {
  height: 100%;
  overflow-y: auto;
}

.tab-empty {
  padding: 2rem;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
  text-align: center;
}

.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.agent-row {
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.agent-line {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 26px;
  min-width: 0;
}

.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted, #a39a8e);
}

.dot.live {
  background: var(--bg-success, #5a7d4f);
}

.agent-name {
  font-size: 0.8125rem;
  font-weight: 550;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.chip {
  font-size: 0.625rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-radius: var(--radius-sm, 4px);
  padding: 0.0625rem 0.3rem;
  white-space: nowrap;
}

.chip.reach.live {
  color: var(--text-accent, #c2532f);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.chip.busy {
  color: var(--text-accent, #c2532f);
}

.chip.bad {
  color: var(--bg-danger, #b3402e);
}

.sess {
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 30%;
}

.spacer {
  flex: 1;
}

.agent-sub {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  padding-left: 1.0625rem;
  min-width: 0;
}

.stamp {
  flex: 0 0 auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.last-text {
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
