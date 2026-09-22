<script setup lang="ts">
// Projects view (F2 in docs/control-center-requirements.md).
//
// A project is a working directory the agents have worked in. Nothing is
// declared by hand: projects are derived from the sessions the agents report,
// so the list is always the truth of what has actually been touched. Numbers
// come from the activity ledger (usage_update / turn events), never invented.
import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { useActivityStore, projectName } from '../stores/activity';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import type { SavedSession } from '../lib/types';

const sessionStore = useSessionStore();
const activity = useActivityStore();
const configStore = useConfigStore();
const uiStore = useUiStore();

const search = ref('');
const agentFilter = ref('');
const selectedCwd = ref('');
const range = ref<7 | 30 | 0>(7);

interface ProjectRow {
  cwd: string;
  name: string;
  sessions: number;
  lastActivity: number;
  agents: string[];
  live: boolean;
  tokens: number;
  cost: number;
  turns: number;
}

/** One row per working directory, aggregated over the sessions we know about. */
const projects = computed<ProjectRow[]>(() => {
  const { from, to } = range.value ? activity.dayRange(range.value) : { from: 0, to: Date.now() };
  const usage = new Map(activity.usageByProject(from, to).map((u) => [u.project, u]));
  const liveSessions = activity.liveSessions;
  const byCwd = new Map<string, SavedSession[]>();
  for (const session of sessionStore.savedSessions) {
    if (!session.cwd) continue;
    const list = byCwd.get(session.cwd) ?? [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }

  const rows: ProjectRow[] = [];
  for (const [cwd, sessions] of byCwd) {
    const name = projectName(cwd);
    const agents = [...new Set(sessions.map((s) => s.agentName))].sort();
    if (agentFilter.value && !agents.includes(agentFilter.value)) continue;
    if (search.value) {
      const needle = search.value.toLowerCase();
      if (!name.toLowerCase().includes(needle) && !cwd.toLowerCase().includes(needle)) continue;
    }
    const stat = usage.get(name);
    const currentBusy =
      sessionStore.isLoading && sessionStore.currentSession?.cwd === cwd;
    rows.push({
      cwd,
      name,
      sessions: sessions.length,
      lastActivity: Math.max(...sessions.map((s) => s.lastUpdated)),
      agents,
      live: currentBusy || sessions.some((s) => liveSessions.has(s.sessionId)),
      tokens: stat?.tokens ?? 0,
      cost: stat?.cost ?? 0,
      turns: stat?.turns ?? 0,
    });
  }
  return rows.sort((a, b) => b.lastActivity - a.lastActivity);
});

const selected = computed(() => projects.value.find((p) => p.cwd === selectedCwd.value) ?? null);

const selectedSessions = computed(() =>
  sessionStore.savedSessions
    .filter((s) => s.cwd === selectedCwd.value)
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
);

const agentsInUse = computed(() => [...new Set(sessionStore.savedSessions.map((s) => s.agentName))].sort());

function formatStamp(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${months[d.getMonth()]}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function relative(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

async function openProject(row: ProjectRow) {
  selectedCwd.value = selectedCwd.value === row.cwd ? '' : row.cwd;
}

async function resume(session: SavedSession) {
  try {
    await sessionStore.resumeSession(session);
    await uiStore.setView('chat');
  } catch (e) {
    console.error('Failed to resume session:', e);
  }
}

/** Start a session in this project's directory with the agent it used most. */
async function newSessionIn(row: ProjectRow) {
  const agent = row.agents[0] ?? configStore.agentNames[0];
  if (!agent) return;
  try {
    await sessionStore.createSession(agent, row.cwd);
    await uiStore.setView('chat');
  } catch (e) {
    console.error('Failed to create session in project:', e);
  }
}
</script>

<template>
  <div class="view-pane">
    <header class="pane-head">
      <h2>Projects</h2>
      <div class="head-controls">
        <input v-model="search" class="search" type="search" placeholder="Filter path or name" aria-label="Filter projects" />
        <select v-model="agentFilter" class="picker" aria-label="Filter by agent">
          <option value="">all agents</option>
          <option v-for="agent in agentsInUse" :key="agent" :value="agent">{{ agent }}</option>
        </select>
        <div class="range" role="group" aria-label="Usage range">
          <button :class="{ active: range === 7 }" @click="range = 7">7d</button>
          <button :class="{ active: range === 30 }" @click="range = 30">30d</button>
          <button :class="{ active: range === 0 }" @click="range = 0">all</button>
        </div>
        <span class="pane-note">{{ projects.length }} projects</span>
      </div>
    </header>

    <div class="pane-body">
      <p v-if="projects.length === 0" class="pane-empty">
        No projects yet. A project appears here once an agent reports a session with a working
        directory.
      </p>

      <ul v-else class="project-list">
        <li
          v-for="row in projects"
          :key="row.cwd"
          class="project-row"
          :class="{ open: row.cwd === selectedCwd }"
          @click="openProject(row)"
        >
          <span class="live-dot" :class="{ on: row.live }" :title="row.live ? 'Working now' : 'Idle'"></span>
          <span class="project-name">{{ row.name }}</span>
          <span class="project-path" :title="row.cwd">{{ row.cwd }}</span>
          <span class="project-agents">{{ row.agents.join(' · ') }}</span>
          <span class="project-stat" :title="`${row.turns} turns in range`">{{ row.sessions }} sess</span>
          <span class="project-stat mono">{{ compactNumber(row.tokens) }}</span>
          <span class="project-stamp">{{ formatStamp(row.lastActivity) }}</span>
        </li>
      </ul>

      <section v-if="selected" class="project-detail">
        <header class="detail-head">
          <div>
            <h3>{{ selected.name }}</h3>
            <p class="detail-path mono">{{ selected.cwd }}</p>
          </div>
          <div class="detail-actions">
            <button class="action" @click="newSessionIn(selected)">New session here</button>
          </div>
        </header>

        <div class="detail-metrics">
          <span class="metric">
            <span class="metric-label">sessions</span>
            <span class="metric-value mono">{{ selected.sessions }}</span>
          </span>
          <span class="metric">
            <span class="metric-label">last activity</span>
            <span class="metric-value mono">{{ relative(selected.lastActivity) }}</span>
          </span>
          <span class="metric">
            <span class="metric-label">tokens ({{ range ? range + 'd' : 'all' }})</span>
            <span class="metric-value mono">{{ compactNumber(selected.tokens) }}</span>
          </span>
          <span class="metric">
            <span class="metric-label">turns</span>
            <span class="metric-value mono">{{ selected.turns }}</span>
          </span>
          <span v-if="selected.cost" class="metric">
            <span class="metric-label">cost</span>
            <span class="metric-value mono">{{ selected.cost.toFixed(2) }}</span>
          </span>
        </div>

        <h4 class="detail-sub">Sessions</h4>
        <ul class="detail-sessions">
          <li
            v-for="session in selectedSessions"
            :key="session.id"
            class="detail-session"
            @click="resume(session)"
          >
            <span class="session-title" :title="session.title">{{ session.title }}</span>
            <span class="session-agent">{{ session.agentName }}</span>
            <span class="session-stamp">{{ formatStamp(session.lastUpdated) }}</span>
          </li>
        </ul>
      </section>
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
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.pane-head h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.head-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.search,
.picker {
  height: 28px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
}

.search {
  width: 180px;
}

.picker {
  max-width: 200px;
}

.range {
  display: flex;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
}

.range button {
  height: 28px;
  padding: 0 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-muted, #a39a8e);
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  cursor: pointer;
}

.range button.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  color: var(--text-accent, #c2532f);
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
  padding: 0.5rem 1rem 1rem;
}

.pane-empty {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
}

.project-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Dense one-line rows: dot · name · path · agents · sessions · tokens · stamp. */
.project-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 30px;
  padding: 0 0.375rem;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
}

.project-row:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.project-row.open {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.live-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-color, #e3dbcf);
}

.live-dot.on {
  background: var(--bg-success, #5a7d4f);
}

.project-name {
  flex: 0 0 auto;
  min-width: 8rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-primary, #2b2723);
}

.project-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-agents {
  flex: 0 0 auto;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
}

.project-stat {
  flex: 0 0 auto;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.project-stat.mono {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  min-width: 3.5rem;
  text-align: right;
}

.project-stamp {
  flex: 0 0 auto;
  min-width: 3.5rem;
  text-align: right;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.project-detail {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
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
}

.action:hover {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
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
  .pane-head {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .head-controls {
    flex-wrap: wrap;
  }

  .search {
    width: 100%;
  }

  .project-path,
  .project-agents {
    display: none;
  }

  .project-row,
  .detail-session {
    min-height: 44px;
  }

  .action {
    min-height: 44px;
  }
}
</style>
