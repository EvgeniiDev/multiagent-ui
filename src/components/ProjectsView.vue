<script setup lang="ts">
// Projects view (F2 in docs/control-center-requirements.md, rescoped by v2 §B).
//
// The list source is the projects REGISTRY (stores/projects.ts via the
// features/scope seam) — one row per registered project — not sessions'
// derived cwds. Sessions, usage and turns aggregate into a project by
// longest-prefix cwd ownership (a session counts once even when projects
// nest). The global scope selector applies: with a project selected the list
// and the detail show only it; 'all' lists every registered project.
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
import { useActivityStore } from '../stores/activity';
import { useConfigStore } from '../stores/config';
import { useUiStore } from '../stores/ui';
import { useProjectsStore } from '../features/scope/registry';
import type { SavedSession } from '../lib/types';
import UiButton from './ui/UiButton.vue';
import ProjectDetail from '../features/projects/ProjectDetail.vue';
import NewSessionDialog from '../features/projects/NewSessionDialog.vue';
import NewProjectDialog from '../features/projects/NewProjectDialog.vue';
import type { ProjectRow } from '../features/projects/types';
import { formatStamp, compactNumber } from '../features/projects/format';

const sessionStore = useSessionStore();
const activity = useActivityStore();
const configStore = useConfigStore();
const uiStore = useUiStore();
const projectsStore = useProjectsStore();

const search = ref('');
const agentFilter = ref('');
const selectedCwd = ref('');
const range = ref<7 | 30 | 0>(7);
const showNewSession = ref(false);
const showNewProject = ref(false);
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

/** Working directory the header's "New session" dialog opens with — the
 *  scoped project's path, or empty at All (agent's default directory). */
const scopeCwd = computed(() => uiStore.activeProject?.path ?? '');

/** One row per REGISTERED project; sessions/usage attach by ownership — the
 *  owning project is the longest-prefix cwd match, so nested projects never
 *  double-count a session. */
const projects = computed<ProjectRow[]>(() => {
  const { from, to } = range.value ? activity.dayRange(range.value) : { from: 0, to: Date.now() };
  const scoped = uiStore.activeProjectId;
  const liveSessions = activity.liveSessions;

  // Tokens/cost/turns per project id over the selected range.
  const stats = new Map<string, { tokens: number; cost: number; turns: number }>();
  const bump = (id: string) => {
    let v = stats.get(id);
    if (!v) stats.set(id, (v = { tokens: 0, cost: 0, turns: 0 }));
    return v;
  };
  for (const u of activity.usageInRange(from, to)) {
    const pid = u.cwd ? projectsStore.projectIdForCwd(u.cwd) : null;
    if (!pid) continue;
    const s = bump(pid);
    s.tokens += Math.max(0, u.used);
    s.cost += u.cost ?? 0;
  }
  for (const e of activity.entriesInRange(from, to)) {
    if (e.kind !== 'turn-end' || !e.cwd) continue;
    const pid = projectsStore.projectIdForCwd(e.cwd);
    if (pid) bump(pid).turns += 1;
  }

  const sessionsByProject = new Map<string, SavedSession[]>();
  for (const s of sessionStore.savedSessions) {
    const pid = s.cwd ? projectsStore.projectIdForCwd(s.cwd) : null;
    if (!pid) continue;
    const list = sessionsByProject.get(pid) ?? [];
    list.push(s);
    sessionsByProject.set(pid, list);
  }

  const rows: ProjectRow[] = [];
  for (const project of projectsStore.projects) {
    if (scoped !== 'all' && project.id !== scoped) continue;
    const sessions = sessionsByProject.get(project.id) ?? [];
    const agents = [...new Set(sessions.map((s) => s.agentName))].sort();
    if (agentFilter.value && !agents.includes(agentFilter.value)) continue;
    if (search.value) {
      const needle = search.value.toLowerCase();
      if (!project.name.toLowerCase().includes(needle) && !project.path.toLowerCase().includes(needle)) continue;
    }
    const stat = stats.get(project.id);
    const currentCwd = sessionStore.currentSession?.cwd;
    rows.push({
      cwd: project.path,
      name: project.name,
      sessions: sessions.length,
      lastActivity: sessions.length
        ? Math.max(...sessions.map((s) => s.lastUpdated))
        : project.createdAt,
      agents,
      live:
        (sessionStore.isLoading &&
          !!currentCwd &&
          projectsStore.projectIdForCwd(currentCwd) === project.id) ||
        sessions.some((s) => liveSessions.has(s.sessionId)),
      tokens: stat?.tokens ?? 0,
      cost: stat?.cost ?? 0,
      turns: stat?.turns ?? 0,
    });
  }
  return rows.sort((a, b) => b.lastActivity - a.lastActivity);
});

// With a project scoped, list AND detail show only it — the detail falls
// back to the single scoped row so no click is needed.
const selected = computed(
  () =>
    projects.value.find((p) => p.cwd === selectedCwd.value) ??
    (uiStore.activeProjectId !== 'all' ? projects.value[0] ?? null : null)
);

const selectedSessions = computed(() => {
  const current = selected.value;
  if (!current) return [];
  const pid = projectsStore.projectIdForCwd(current.cwd);
  return sessionStore.savedSessions
    .filter((s) => s.cwd && projectsStore.projectIdForCwd(s.cwd) === pid)
    .sort((a, b) => b.lastUpdated - a.lastUpdated);
});

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

/** A project was just created in the New project dialog (it is already the
 * active scope): select it so the detail pane opens on it right away. */
function handleProjectCreated(projectId: string) {
  const created = projectsStore.projects.find((p) => p.id === projectId);
  if (created) selectedCwd.value = created.path;
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
        <input v-model="search" class="ui-input search" type="search" placeholder="Filter path or name" aria-label="Filter projects" />
        <select v-model="agentFilter" class="ui-input picker" aria-label="Filter by agent">
          <option value="">all agents</option>
          <option v-for="agent in agentsInUse" :key="agent" :value="agent">{{ agent }}</option>
        </select>
        <div class="range" role="group" aria-label="Usage range">
          <UiButton variant="ghost" :aria-pressed="range === 7" @click="range = 7">7d</UiButton>
          <UiButton variant="ghost" :aria-pressed="range === 30" @click="range = 30">30d</UiButton>
          <UiButton variant="ghost" :aria-pressed="range === 0" @click="range = 0">all</UiButton>
        </div>
        <span class="pane-note">{{ projects.length }} projects</span>
        <UiButton class="new-project-cta" type="button" @click="showNewProject = true">
          New project
        </UiButton>
        <UiButton class="new-session-cta" type="button" @click="showNewSession = true">
          New session
        </UiButton>
      </div>
    </header>

    <div class="pane-body">
      <p v-if="projects.length === 0" class="pane-empty">
        No projects match. Projects are registered in Settings &rarr; Projects;
        the global scope selector and the filters above narrow this list.
      </p>

      <template v-else>
        <div ref="listEl" class="list-col">
          <ul class="project-list">
            <template v-for="row in projects" :key="row.cwd">
              <li>
                <UiButton variant="row"
                  class="project-row"
                  :class="{ open: row.cwd === selectedCwd }"
                  :aria-pressed="row.cwd === selectedCwd"
                  @click="openProject(row)"
                >
                  <span class="live-dot" :class="{ on: row.live }" :title="row.live ? 'Working now' : 'Idle'"></span>
                  <span class="project-name">{{ row.name }}</span>
                  <span class="project-path" :title="row.cwd">{{ row.cwd }}</span>
                  <span class="project-agents">{{ row.agents.join(' · ') }}</span>
                  <span class="project-stat" :title="`${row.turns} turns in range`">{{ row.sessions }} sess</span>
                  <span class="project-stat mono">{{ compactNumber(row.tokens) }}</span>
                  <span class="project-stamp">{{ formatStamp(row.lastActivity) }}</span>
                </UiButton>
              </li>
              <li
                v-if="isNarrow && selected && row.cwd === selected.cwd"
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

    <NewSessionDialog
      v-if="showNewSession"
      :initial-cwd="scopeCwd"
      @close="showNewSession = false"
    />

    <NewProjectDialog
      v-if="showNewProject"
      @close="showNewProject = false"
      @created="handleProjectCreated"
    />
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
.search { width: 180px; }
.picker { max-width: 200px; }

.range {
  display: flex;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
}

.pane-note {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
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
.project-row { display: flex; align-items: center; gap: 0.625rem; }

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
.search { width: 100%; }

  .project-path,
  .project-agents {
    display: none;
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
