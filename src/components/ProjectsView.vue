<script setup lang="ts">
// Projects view (F2 in docs/control-center-requirements.md).
//
// A project is a working directory the agents have worked in. Nothing is
// declared by hand: projects are derived from the sessions the agents report,
// so the list is always the truth of what has actually been touched. Numbers
// come from the activity ledger (usage_update / turn events), never invented.
//
// Layout is a real two-pane view: the project list lives in its own
// scrollable column on the left, the detail pane sits beside it with its own
// scroll. Previously the detail rendered as the last child of the scrolling
// list — on any list longer than the viewport a click selected a row but
// produced no visible change (measured: detail y = 1297 in a 900px viewport
// with 41 rows). Under 800px the panes collapse to one column and the detail
// is inlined directly under the clicked row, scrolled into view on select.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { useActivityStore, projectName } from '../stores/activity';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import type { SavedSession } from '../lib/types';
import ProjectDetail from '../features/projects/ProjectDetail.vue';
import NewSessionDialog from '../features/projects/NewSessionDialog.vue';
import type { ProjectRow } from '../features/projects/types';
import { formatStamp, compactNumber } from '../features/projects/format';

const sessionStore = useSessionStore();
const activity = useActivityStore();
const configStore = useConfigStore();
const uiStore = useUiStore();

const search = ref('');
const agentFilter = ref('');
const selectedCwd = ref('');
const range = ref<7 | 30 | 0>(7);
const showNewSession = ref(false);
const listEl = ref<HTMLElement | null>(null);

// Same 800px breakpoint as the sidebar drawer in App.vue. When it matches,
// the detail is rendered inline under the clicked row instead of in the
// (hidden) second column.
const isNarrow = ref(false);
let narrowMql: MediaQueryList | null = null;
function syncNarrow() {
  if (narrowMql) isNarrow.value = narrowMql.matches;
}
onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia('(max-width: 800px)');
    syncNarrow();
    narrowMql.addEventListener('change', syncNarrow);
  }
});
onBeforeUnmount(() => {
  if (narrowMql) {
    narrowMql.removeEventListener('change', syncNarrow);
    narrowMql = null;
  }
});

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

async function openProject(row: ProjectRow) {
  selectedCwd.value = selectedCwd.value === row.cwd ? '' : row.cwd;
  if (selectedCwd.value && isNarrow.value) {
    // The detail mounts inline as the clicked row's next sibling; pull it
    // into view so the tap visibly produces something even near the bottom
    // of a long list.
    await nextTick();
    listEl.value
      ?.querySelector('.project-inline-detail')
      ?.scrollIntoView({ block: 'nearest' });
  }
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
        <button class="new-session-cta" type="button" @click="showNewSession = true">
          New session
        </button>
      </div>
    </header>

    <div class="pane-body">
      <p v-if="projects.length === 0" class="pane-empty">
        No projects yet. A project appears here once an agent reports a session with a working
        directory.
      </p>

      <template v-else>
        <div ref="listEl" class="list-col">
          <ul class="project-list">
            <template v-for="row in projects" :key="row.cwd">
              <li
                class="project-row"
                :class="{ open: row.cwd === selectedCwd }"
                :aria-current="row.cwd === selectedCwd ? 'true' : undefined"
                tabindex="0"
                @click="openProject(row)"
                @keydown.enter.prevent="openProject(row)"
                @keydown.space.prevent="openProject(row)"
              >
                <span class="live-dot" :class="{ on: row.live }" :title="row.live ? 'Working now' : 'Idle'"></span>
                <span class="project-name">{{ row.name }}</span>
                <span class="project-path" :title="row.cwd">{{ row.cwd }}</span>
                <span class="project-agents">{{ row.agents.join(' · ') }}</span>
                <span class="project-stat" :title="`${row.turns} turns in range`">{{ row.sessions }} sess</span>
                <span class="project-stat mono">{{ compactNumber(row.tokens) }}</span>
                <span class="project-stamp">{{ formatStamp(row.lastActivity) }}</span>
              </li>
              <li
                v-if="isNarrow && row.cwd === selectedCwd"
                class="project-inline-detail"
              >
                <ProjectDetail
                  :project="row"
                  :sessions="selectedSessions"
                  :range="range"
                  @close="selectedCwd = ''"
                  @resume="resume"
                  @new-session="newSessionIn"
                />
              </li>
            </template>
          </ul>
        </div>

        <div class="detail-col">
          <ProjectDetail
            v-if="selected && !isNarrow"
            :project="selected"
            :sessions="selectedSessions"
            :range="range"
            @close="selectedCwd = ''"
            @resume="resume"
            @new-session="newSessionIn"
          />
          <p v-else class="detail-placeholder">
            Select a project to see its sessions and usage.
          </p>
        </div>
      </template>
    </div>

    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" />
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

.new-session-cta {
  height: 28px;
  padding: 0 0.75rem;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fbf8f3);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.new-session-cta:hover {
  background: var(--bg-primary-hover, #a8431f);
}

/* Two independently scrolling panes: list column on the left (fixed band,
 * never grows), detail column taking the rest. The body itself only frames
 * them — it no longer scrolls, so a click can never render its result below
 * the fold. */
.pane-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.list-col {
  flex: 0 0 auto;
  width: clamp(340px, 30vw, 420px);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.5rem 0.75rem 1rem;
  border-right: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.detail-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 1rem 1.25rem;
}

.detail-placeholder {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
}

.pane-empty {
  margin: 0;
  padding: 1rem;
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

.project-row:focus-visible {
  outline: 2px solid var(--bg-primary, #c2532f);
  outline-offset: -2px;
}

/* Selected row: accent bar on the left edge + active tint — visible from
 * across the list, not just on hover. */
.project-row.open {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  box-shadow: inset 3px 0 0 var(--bg-primary, #c2532f);
}

.project-row.open .project-name {
  font-weight: 600;
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
  min-width: 6rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* The list column is narrow by design: agents and token counts are repeated
 * in the detail pane, so they collapse out of the row first. */
.list-col .project-agents,
.list-col .project-stat.mono {
  display: none;
}

/* Inline detail (narrow layout): framed card directly under the clicked row. */
.project-inline-detail {
  margin: 0.125rem 0 0.5rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-left: 3px solid var(--bg-primary, #c2532f);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
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
    height: 44px;
  }

  .picker {
    height: 44px;
  }

  .range button {
    height: 44px;
  }

  .new-session-cta {
    min-height: 44px;
  }

  .project-path,
  .project-agents {
    display: none;
  }

  .project-row {
    min-height: 44px;
  }

  /* Single column: the list takes the full pane and scrolls; the second
   * column (which only ever holds the placeholder or the desktop detail)
   * drops out entirely — the detail renders inline under the row instead. */
  .list-col {
    flex: 1;
    width: auto;
    border-right: none;
    padding: 0.5rem 0.75rem 1rem;
  }

  .detail-col {
    display: none;
  }
}
</style>
