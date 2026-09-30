<script setup lang="ts">
// Workflow side panel — the porch-run stepper docked next to the chat feed
// (composer's run-mode = "workflow"). Same store and stepper as the former
// top-level Workflow view, minus the run-list strip: in a narrow column the
// panel just follows the latest run ("auto-trigger"); pinning a run stays
// possible via the store, this surface doesn't need the list.
//
// Data path: state server's read-only porch endpoints (GET /api/porch/runs,
// GET /api/porch/runs/:id) polled by src/stores/workflow.ts every 2s while
// this panel is mounted.
import { computed, onMounted, onBeforeUnmount } from 'vue';
import { useWorkflowStore } from '../stores/workflow';
import { DIRECTIONS } from '../lib/porch/graph';
import type { Direction } from '../lib/porch/types';
import WorkflowStepper from '../features/workflow/WorkflowStepper.vue';

const wf = useWorkflowStore();

// initWorkflowStore() can resolve after unmount (loadKvStore waits on the
// state server). Without this guard the .then below would start a 2s
// interval the Pinia store then keeps for the rest of the session.
let disposed = false;

onMounted(() => {
  void wf.initWorkflowStore().then(() => {
    if (!disposed) wf.startPolling();
  });
});
onBeforeUnmount(() => {
  disposed = true;
  wf.stopPolling();
});

const DIR_LABELS: Record<Direction, string> = {
  run: 'Run',
  delegate: 'Delegate',
  ask: 'Ask',
  code: 'Code',
  pipeline: 'Pipeline',
};

function shortId(runId: string): string {
  return runId.replace(/^run_/, '');
}

/** "<runId-tail> · <agent>@<backend> · <model> · <status> · <elapsed>". */
const summaryLine = computed(() => {
  const meta = wf.detail?.meta;
  const sum = wf.selectedSummary;
  if (!meta && !sum) return '';
  const parts: string[] = [];
  const runId = meta?.run_id ?? sum?.runId;
  if (runId) parts.push(shortId(runId));
  const agent = meta?.agent_id ?? sum?.agentId;
  const backend = meta?.backend ?? sum?.backend;
  if (agent || backend) parts.push(`${agent ?? '?'}@${backend ?? '?'}`);
  const status = meta?.status ?? sum?.status;
  if (status) parts.push(status);
  const started = meta?.started_at ?? sum?.startedAt;
  const finished = meta?.finished_at ?? sum?.finishedAt;
  const startMs = started ? Date.parse(started) : NaN;
  const endMs = finished ? Date.parse(finished) : wf.now;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    const s = Math.round((endMs - startMs) / 1000);
    if (s < 60) parts.push(`${s}s`);
    else if (s < 3600) parts.push(`${Math.floor(s / 60)}m ${s % 60}s`);
    else parts.push(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  }
  return parts.join(' · ');
});

const nodeCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const n of wf.nodes) {
    const c = wf.eventsFor(n.id).length;
    if (c > 0) out[n.id] = c;
  }
  return out;
});
</script>

<template>
  <aside class="wf-panel" :aria-busy="!wf.ready">
    <header class="panel-head">
      <h2>Workflow</h2>
      <span class="panel-note" aria-live="polite" :title="summaryLine">{{ summaryLine }}</span>
    </header>

    <nav class="tab-bar" aria-label="Workflow direction">
      <button
        v-for="d in DIRECTIONS"
        :key="d"
        class="tab-btn"
        :class="{ active: wf.direction === d }"
        role="tab"
        :aria-selected="wf.direction === d"
        :title="wf.manualDirection === d ? 'Manual pick — click again to follow the run\'s direction' : undefined"
        @click="wf.setDirection(d)"
      >
        {{ DIR_LABELS[d] }}
      </button>
    </nav>

    <div v-if="wf.staleText" class="wf-banner" role="status">{{ wf.staleText }}</div>
    <div v-if="wf.errorText || wf.errorMessage" class="wf-banner error" role="alert">
      {{ wf.errorText ?? wf.errorMessage }}
    </div>

    <div class="panel-body">
      <template v-if="wf.porchUp === false">
        <div class="wf-empty">
          <p>Porch endpoint unreachable.</p>
          <p class="wf-hint">The state server (port 25900) is not answering — start the stack with <code>docker compose up -d</code>.</p>
        </div>
      </template>
      <template v-else-if="wf.porchUp && wf.runs.length === 0">
        <div class="wf-empty">
          <p>No porch runs yet.</p>
          <p class="wf-hint">Dispatch one from a shell: <code>scripts/porch-dispatch -a &lt;agent&gt; --cwd &lt;dir&gt; "&lt;task&gt;"</code></p>
        </div>
      </template>
      <template v-else>
        <WorkflowStepper
          :nodes="wf.nodes"
          :active-index="wf.activeNodeIndex"
          :terminal="wf.terminal"
          :expanded-node-id="wf.expandedNodeId"
          :expanded-blocks="wf.expandedBlocks"
          :counts="nodeCounts"
          @toggle="wf.toggleNode"
        />
        <div v-if="wf.auditTruncated" class="wf-tail-note">showing last 512 KiB of audit.jsonl</div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.wf-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.panel-head h2 {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 600;
}

.panel-note {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.tab-bar {
  display: flex;
  gap: 0.125rem;
  padding: 0 0.5rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  overflow-x: auto;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 28px;
  padding: 0 0.5rem;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.71875rem;
  cursor: pointer;
  white-space: nowrap;
}

.tab-btn:hover {
  color: var(--text-primary, #2b2723);
}

.tab-btn.active {
  color: var(--text-accent, #c2532f);
  border-bottom-color: var(--text-accent, #c2532f);
}

.tab-btn:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: -2px;
}

.wf-banner {
  padding: 0.3125rem 0.875rem;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}
.wf-banner.error {
  color: var(--text-accent, #c2532f);
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.wf-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 1.5rem;
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
  text-align: center;
}
.wf-hint {
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}
.wf-hint code {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
}

.wf-tail-note {
  padding: 0.25rem 0.875rem;
  font-family: var(--font-mono, monospace);
  font-size: 0.5625rem;
  color: var(--text-muted, #a39a8e);
}
</style>
