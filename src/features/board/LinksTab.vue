<script setup lang="ts">
// Links tab (F10.6): the pm role's verdict surface.
//
// Everything here derives from the two stores the panel already keeps —
// no parallel pm state: the card graph (`dependsOn` / `blocks` /
// `conflictsWith` / `blocked`) comes from board.json, the audit trail from
// activity.json's `pm` entries. The pm agent itself writes substance
// proposals to <projectPath>/.acp/pm/proposals.md; the tab reads that file
// through the fs bridge (read-only) when a single project is in scope and
// the bridge answers — the ledger's `proposed:` rows are always shown.
import { computed, ref, watch } from 'vue';
import { useBoardStore, type BoardCard } from '../../stores/board';
import { useActivityStore, type ActivityEntry } from '../../stores/activity';
import { useUiStore } from '../../stores/ui';
import { useConfigStore } from '../../stores/config';
import {
  bridgeBaseUrlForAgentUrl,
  defaultBridgeBaseUrl,
} from '../settings/fsApi';
import { readTextFile } from '../../lib/fsApi';
import { fmtStamp } from './format';

const emit = defineEmits<{
  'open-card': [cardId: string];
}>();

const board = useBoardStore();
const activity = useActivityStore();
const uiStore = useUiStore();
const configStore = useConfigStore();

const id8 = (id: string) => id.slice(0, 8);

function cardById(id: string): BoardCard | null {
  return board.cards.find((c) => c.id === id) ?? null;
}

function cardLabel(id: string): string {
  const c = cardById(id);
  return c ? `${id8(id)} ${c.title}` : `${id8(id)} (gone)`;
}

// ---- pm audit feed ----------------------------------------------------------
//
// pmgraph appends kind:'pm' entries: the run summary (`run <id>: ...`),
// one `applied:` row per safe change and one `proposed:` row per substance
// proposal. Entries of one run share `sessionId` (the run id).

const pmEntries = computed(() =>
  activity.entries.filter((e) => e.kind === 'pm')
);

const lastRun = computed(() =>
  [...pmEntries.value].reverse().find((e) => (e.detail || '').startsWith('run ')) ?? null
);

const appliedEntries = computed(() =>
  pmEntries.value.filter((e) => (e.detail || '').startsWith('applied:')).slice().reverse()
);

const proposedEntries = computed(() =>
  pmEntries.value.filter((e) => (e.detail || '').startsWith('proposed:')).slice().reverse()
);

const keptReason = computed(() => (e: ActivityEntry) => e.detail || '');

// ---- the card graph (live, from board.json) ---------------------------------
//
// Relation rows are derived from the cards in the active project scope;
// an edge is listed once (dependsOn and its blocks mirror name the same
// fact — dependsOn wins so a mirrored pair renders once).

interface RelRow {
  key: string;
  from: string;
  to: string;
  kind: 'dependsOn' | 'conflictsWith';
  live: boolean;
}

const relRows = computed<RelRow[]>(() => {
  const rows: RelRow[] = [];
  for (const c of board.scopedCards) {
    for (const t of c.dependsOn) {
      rows.push({
        key: `${c.id}:dep:${t}`,
        from: c.id, to: t, kind: 'dependsOn',
        live: cardById(t)?.stage !== 'done',
      });
    }
    for (const t of c.conflictsWith) {
      if (c.id < t) {
        rows.push({
          key: `${c.id}:conf:${t}`,
          from: c.id, to: t, kind: 'conflictsWith',
          live: true,
        });
      }
    }
  }
  return rows;
});

const blockedCards = computed(() =>
  board.scopedCards.filter((c) => c.blocked)
);

/** Cards the tab header counts as "problems": visibly blocked or in a
 * declared conflict. */
const problemCount = computed(
  () => board.scopedCards.filter((c) => c.blocked || c.conflictsWith.length).length
);
defineExpose({ problemCount });

// ---- proposals file (read-only via the fs bridge) ---------------------------

const proposalsFile = ref<{ path: string; content: string } | null>(null);
const proposalsErr = ref('');

const proposalsPath = computed(() => {
  const p = uiStore.activeProject;
  return p ? `${p.path}/.acp/pm/proposals.md` : '';
});

function bridgeBase(): string {
  for (const name of configStore.allAgentNames) {
    const base = bridgeBaseUrlForAgentUrl(configStore.getAgent(name)?.url);
    if (base) return base;
  }
  return defaultBridgeBaseUrl();
}

async function loadProposals() {
  proposalsFile.value = null;
  proposalsErr.value = '';
  const path = proposalsPath.value;
  if (!path) return;
  try {
    const res = await readTextFile(bridgeBase(), path);
    proposalsFile.value = { path: res.path, content: res.content };
  } catch (e) {
    proposalsErr.value = e instanceof Error ? e.message : String(e);
  }
}

watch(proposalsPath, () => void loadProposals(), { immediate: true });
</script>

<template>
  <div class="links-tab">
    <p class="links-hint">
      The <span class="mono">pm</span> role reviews the card graph and reports.
      Links and <span class="mono">pm:</span> blocked marks are applied by the
      tool; anything that changes a card's substance is only proposed.
    </p>

    <div v-if="lastRun" class="run-line" data-testid="pm-last-run">
      <span class="mono stamp">{{ fmtStamp(lastRun.at) }}</span>
      <span class="run-detail mono" :title="lastRun.detail">{{ lastRun.detail }}</span>
    </div>
    <div v-else class="run-line" data-testid="pm-no-run">
      <span class="run-detail">No pm run recorded yet.</span>
    </div>

    <!-- Proposed — substance changes are NEVER applied, they wait here for
         a human. Ledger rows first (always visible), then the proposals
         file itself when a single project is in scope and the fs bridge
         answers. -->
    <section class="lnk-section" data-testid="pm-proposals">
      <h3>Proposed — for a human</h3>
      <ul v-if="proposedEntries.length" class="lnk-list">
        <li v-for="e in proposedEntries" :key="e.id" class="lnk-row proposed">
          <span class="mono stamp">{{ fmtStamp(e.at) }}</span>
          <span class="lnk-card" :title="e.title">{{ e.title }}</span>
          <span class="lnk-detail" :title="keptReason(e)">{{ e.detail }}</span>
        </li>
      </ul>
      <p v-else class="lnk-empty">Nothing proposed.</p>
      <template v-if="proposalsPath">
        <p v-if="proposalsFile" class="lnk-file mono" data-testid="pm-proposals-path">
          {{ proposalsFile.path }}
        </p>
        <pre
          v-if="proposalsFile"
          class="lnk-proposals mono"
          data-testid="pm-proposals-file"
        >{{ proposalsFile.content }}</pre>
        <p v-else-if="proposalsErr" class="lnk-error" data-testid="pm-proposals-error">
          {{ proposalsPath }} — {{ proposalsErr }}
        </p>
      </template>
      <p v-else class="lnk-empty">Pick a project to read its proposals file.</p>
    </section>

    <section class="lnk-section" data-testid="pm-applied">
      <h3>Applied by pm</h3>
      <ul v-if="appliedEntries.length" class="lnk-list">
        <li v-for="e in appliedEntries" :key="e.id" class="lnk-row">
          <span class="mono stamp">{{ fmtStamp(e.at) }}</span>
          <span class="lnk-card" :title="e.title">{{ e.title }}</span>
          <span class="lnk-detail" :title="keptReason(e)">{{ e.detail }}</span>
        </li>
      </ul>
      <p v-else class="lnk-empty">No applied changes recorded.</p>
    </section>

    <section class="lnk-section" data-testid="pm-graph">
      <h3>Card graph</h3>
      <ul v-if="relRows.length" class="lnk-list">
        <li v-for="r in relRows" :key="r.key" class="lnk-row rel" :class="{ done: !r.live }">
          <button class="lnk-chip" :title="cardLabel(r.from)" @click="emit('open-card', r.from)">
            {{ id8(r.from) }}
          </button>
          <span class="lnk-rel mono">{{ r.kind === 'dependsOn' ? 'depends on' : 'conflicts' }}</span>
          <button class="lnk-chip" :title="cardLabel(r.to)" @click="emit('open-card', r.to)">
            {{ id8(r.to) }}
          </button>
          <span class="lnk-title" :title="cardLabel(r.to)">{{ cardById(r.to)?.title || '' }}</span>
        </li>
      </ul>
      <p v-else class="lnk-empty">No links between cards yet.</p>
    </section>

    <section class="lnk-section" data-testid="pm-blocked">
      <h3>Blocked cards</h3>
      <ul v-if="blockedCards.length" class="lnk-list">
        <li v-for="c in blockedCards" :key="c.id" class="lnk-row">
          <button class="lnk-chip" :title="cardLabel(c.id)" @click="emit('open-card', c.id)">
            {{ id8(c.id) }}
          </button>
          <span class="lnk-title">{{ c.title }}</span>
          <span class="lnk-detail" :title="c.blockedReason">{{ c.blockedReason || 'no reason' }}</span>
        </li>
      </ul>
      <p v-else class="lnk-empty">No blocked cards in scope.</p>
    </section>
  </div>
</template>

<style scoped>
.links-tab {
  height: 100%;
  overflow-y: auto;
}

.links-hint {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.run-line {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  font-size: 0.75rem;
}

.run-detail {
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lnk-section {
  padding: 0.5rem 0.75rem 0.625rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.lnk-section h3 {
  margin: 0 0 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.lnk-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.lnk-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 24px;
  font-size: 0.75rem;
}

.lnk-row.proposed .lnk-detail {
  color: var(--text-accent, #c2532f);
}

.lnk-row.rel.done {
  opacity: 0.55;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.stamp {
  flex: 0 0 auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.lnk-card {
  flex: 0 1 auto;
  max-width: 30%;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lnk-detail {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lnk-chip {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  padding: 0.0625rem 0.3rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-accent, #c2532f);
  cursor: pointer;
}

.lnk-chip:hover {
  border-color: var(--text-accent, #c2532f);
}

.lnk-rel {
  flex: 0 0 auto;
  font-size: 0.625rem;
  letter-spacing: 0.03em;
  color: var(--text-muted, #a39a8e);
}

.lnk-title {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lnk-empty {
  margin: 0.125rem 0;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.lnk-file {
  margin: 0.375rem 0 0.125rem;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.lnk-proposals {
  margin: 0.25rem 0 0;
  padding: 0.5rem;
  max-height: 16rem;
  overflow: auto;
  font-size: 0.6875rem;
  line-height: 1.45;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.lnk-error {
  margin: 0.25rem 0 0;
  font-size: 0.6875rem;
  color: var(--bg-danger, #b3402e);
}
</style>
