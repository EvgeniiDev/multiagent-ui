<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
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
import { useExecutionStore } from '../stores/execution';
import { useBoardStore } from '../stores/board';
import { DIRECTIONS } from '../lib/porch/graph';
import type { Direction } from '../lib/porch/types';
import WorkflowStepper from '../features/workflow/WorkflowStepper.vue';
import ManagedRunEvents from '../features/board/ManagedRunEvents.vue';
import {
  approveWorkOrderPayload,
  canApproveWorkOrder,
  canExcludePanelist,
  canRetryParticipant,
  excludePanelistPayload,
  fmtTs,
  fusion as fusionState,
  fusionParticipants,
  fusionPendingActions,
  fusionStatusLabel,
  fusionWorkOrders,
  participantStatusLabel,
  pendingActionText,
  phaseLabel,
  resultKindLabel,
  retryParticipantPayload,
  runStatusLabel,
  shortId as execShortId,
} from '../lib/execution/ui-model';

const wf = useWorkflowStore();
const exec = useExecutionStore();
const board = useBoardStore();

// initWorkflowStore() can resolve after unmount (loadKvStore waits on the
// state server). Without this guard the .then below would start a 2s
// interval the Pinia store then keeps for the rest of the session.
let disposed = false;

let indexTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void wf.initWorkflowStore().then(() => {
    if (!disposed) wf.startPolling();
  });
  void exec.refreshIndex();
  void exec.loadPresets();
  // The managed index refreshes while this panel is mounted — the store's
  // own poll only covers watched/focused cards.
  indexTimer = setInterval(() => void exec.refreshIndex(), 2000);
});
onBeforeUnmount(() => {
  disposed = true;
  wf.stopPolling();
  exec.clearFocus();
  if (indexTimer !== null) {
    clearInterval(indexTimer);
    indexTimer = null;
  }
});

// ---- managed runs (U6) -----------------------------------------------------
// The managed section reads ONLY the execution API — porch state stays
// untouched. `exec.focused` pins one managed run's detail below the list;
// the board's drawer routes here via execStore.openManagedRun().

const focusedState = computed(() =>
  exec.focused ? exec.stateFor(exec.focused.cardId) : null,
);
const focusedRun = computed(() => focusedState.value?.run ?? null);
const focusedCardTitle = computed(() => {
  const id = exec.focused?.cardId;
  if (!id) return '';
  return board.cards.find((c) => c.id === id)?.title ?? id;
});
/** Every run recorded on the focused card — historical detail stays
 * selectable; `reserved` is the server's own reservation flag. */
const focusedRuns = computed(() => focusedState.value?.view?.runs ?? []);

function onSelectManagedRun(e: Event): void {
  const runId = (e.target as HTMLSelectElement).value;
  if (exec.focused && runId) void exec.selectRun(exec.focused.cardId, runId);
}

function cardLabel(cardId: string): string {
  return board.cards.find((c) => c.id === cardId)?.title || cardId.slice(0, 8);
}

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

// ---- fusion run detail (F4) -------------------------------------------------
// The managed section renders the durable run.fusion state for the
// focused card and exposes the pending user decisions — the same commands
// the card drawer issues, through the same store path (one click = one
// POST, never queued offline).

const focusedFusion = computed(() => fusionState(focusedRun.value));
const focusedBusy = computed(() => focusedState.value?.busy ?? null);
const managedOffline = computed(() => exec.online === false);

const fzParticipantLine = computed(() => {
  const parts = fusionParticipants(focusedRun.value);
  if (!parts.length) return '';
  const byStatus = new Map<string, number>();
  for (const p of parts) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  return [...byStatus.entries()].map(([s, n]) => `${n} ${participantStatusLabel(s)}`).join(' · ');
});

/** Gate check for a fusion action on the focused run — offline or a
 * command already in flight disables with a title reason. */
function fusionGate(gate: { ok: boolean; reason: string }): { disabled: boolean; title: string } {
  if (managedOffline.value) {
    return { disabled: true, title: 'state server unreachable — actions are disabled' };
  }
  if (focusedBusy.value) {
    return { disabled: true, title: `a ${focusedBusy.value} command is still in flight` };
  }
  return { disabled: !gate.ok, title: gate.ok ? '' : gate.reason };
}

async function sendFusionCommand(
  type: 'retry_participant' | 'exclude_panelist' | 'approve_work_order',
  payload: Record<string, unknown>,
): Promise<void> {
  const cardId = exec.focused?.cardId;
  if (!cardId) return;
  const r = await exec.sendCommand(cardId, type, payload);
  if (!r.ok && r.error) alert(r.error);
}

async function onManagedRetry(pid: string) {
  const r = focusedRun.value;
  if (!r) return;
  await sendFusionCommand('retry_participant', retryParticipantPayload(r, pid));
}

async function onManagedExclude(pid: string) {
  const r = focusedRun.value;
  if (!r) return;
  const reason = prompt(`Exclude panelist ${pid} — reason (optional):`, 'repeated failures');
  if (reason === null) return;
  if (!confirm(`Exclude ${pid} from this panel? The exclusion is durable.`)) return;
  await sendFusionCommand('exclude_panelist', excludePanelistPayload(r, pid, reason));
}

async function onManagedApproveWo(versionId: string) {
  const r = focusedRun.value;
  if (!r) return;
  const wo = fusionWorkOrders(r).find((w) => w.versionId === versionId);
  const payload = wo ? approveWorkOrderPayload(r, wo) : null;
  if (!payload) {
    alert('the work-order record is incomplete — version or hash missing');
    return;
  }
  if (!confirm(`Approve work order ${versionId}?`)) return;
  await sendFusionCommand('approve_work_order', payload);
}
</script>

<template>
  <aside class="wf-panel" :aria-busy="!wf.ready">
    <header class="panel-head">
      <h2>Workflow</h2>
      <span class="panel-note" aria-live="polite" :title="summaryLine">{{ summaryLine }}</span>
    </header>

    <nav class="tab-bar" aria-label="Workflow direction">
      <UiButton variant="tab"
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
      </UiButton>
    </nav>

    <div v-if="wf.staleText" class="wf-banner" role="status">{{ wf.staleText }}</div>
    <div v-if="wf.errorText || wf.errorMessage" class="wf-banner error" role="alert">
      {{ wf.errorText ?? wf.errorMessage }}
    </div>

    <div class="panel-body">
      <!-- Managed card runs (execution API) — separate source/events,
           porch display below is untouched. -->
      <section v-if="exec.managedIndex.length || exec.focused" class="managed" data-testid="managed-section">
        <div class="managed-head">
          <span class="managed-title">Managed runs</span>
          <span v-if="exec.indexError" class="managed-err">{{ exec.indexError }}</span>
        </div>
        <UiButton variant="row" size="xs" :aria-pressed="exec.focused?.cardId === mc.cardId"
          v-for="mc in exec.managedIndex"
          :key="mc.cardId"
          class="managed-row mono"
          :class="{ sel: exec.focused?.cardId === mc.cardId }"
          @click="exec.openManagedRun(mc.cardId, mc.currentRunId)"
        >
          <span class="managed-card" :title="cardLabel(mc.cardId)">{{ cardLabel(mc.cardId) }}</span>
          <span v-if="mc.currentRun?.mode === 'fusion'" class="managed-mode" title="fusion panel run">fusion</span>
          <span v-if="mc.currentRun?.pending" class="managed-pending" :data-testid="`managed-pending-${mc.cardId}`" title="this run is waiting on a user decision">needs you</span>
          <span class="managed-run">{{ mc.currentRunId ? execShortId(mc.currentRunId) : 'no run' }}</span>
        </UiButton>

        <div v-if="exec.focused" class="managed-detail" data-testid="managed-detail">
          <div class="managed-detailhead mono">
            {{ execShortId(focusedState?.selectedRunId ?? exec.focused.runId ?? '') }}
            <template v-if="focusedRun">
              · {{ runStatusLabel(focusedRun.status) }}<template v-if="focusedRun.phase"> · {{ phaseLabel(focusedRun.phase) }}</template>
            </template>
          </div>
          <p class="managed-sub mono">
            {{ focusedCardTitle }}<template v-if="focusedState?.view?.currentRunId"> · current {{ execShortId(focusedState.view.currentRunId) }}</template>
          </p>
          <div v-if="focusedRuns.length" class="managed-runsel">
            <label class="managed-sub mono">run
              <select
                class="ui-input managed-sel"
                :value="focusedState?.selectedRunId ?? ''"
                data-testid="managed-run-select"
                @change="onSelectManagedRun"
              >
                <option v-for="r in [...focusedRuns].reverse()" :key="r.id" :value="r.id">
                  {{ execShortId(r.id) }} · {{ r.status ?? '?' }}{{ r.reserved ? ' · reserved' : '' }}
                </option>
              </select>
            </label>
          </div>
          <p v-if="focusedState?.runError" class="managed-err mono" data-testid="managed-run-error">
            {{ focusedState.runError }}
            <UiButton variant="secondary" size="xs" data-testid="managed-run-retry" @click="exec.focused && void exec.refreshRun(exec.focused.cardId)">retry</UiButton>
          </p>
          <p v-else-if="!focusedRun" class="managed-sub mono">
            {{ focusedState?.runInflight ? 'loading run detail…' : 'no detail loaded' }}
          </p>
          <template v-else>
            <p v-if="focusedRun.error" class="managed-sub mono">error: {{ focusedRun.error }}</p>

            <!-- fusion state (F4): composition, participant roll-up and
                 the durable pending user decisions with their controls -->
            <div v-if="focusedFusion" class="managed-fusion" data-testid="managed-fusion">
              <p class="managed-sub mono" data-testid="managed-fusion-kind">
                fusion · {{ resultKindLabel(focusedFusion.resultKind) }}
                · panel {{ fusionStatusLabel(focusedFusion.status) }}
                · search {{ focusedFusion.snapshot?.search?.enabled ? 'on' : 'off' }}
              </p>
              <p v-if="fzParticipantLine" class="managed-sub mono" data-testid="managed-fusion-participants">
                {{ fzParticipantLine }}
              </p>
              <div
                v-for="a in fusionPendingActions(focusedRun)"
                :key="a.type + ':' + ((a as Record<string,unknown>).participantId ?? (a as Record<string,unknown>).versionId)"
                class="managed-action"
                :data-testid="`managed-action-${a.type}`"
              >
                <span class="managed-warn">{{ pendingActionText(a, focusedRun) }}</span>
                <template v-if="a.type === 'participant_decision'">
                  <UiButton variant="secondary" size="xs"
                    :data-testid="`managed-retry-${a.participantId}`"
                    :disabled="fusionGate(canRetryParticipant(focusedRun, a.participantId)).disabled"
                    :title="fusionGate(canRetryParticipant(focusedRun, a.participantId)).title"
                    @click="onManagedRetry(a.participantId)"
                  >retry</UiButton>
                  <UiButton variant="secondary" size="xs"
                    :data-testid="`managed-exclude-${a.participantId}`"
                    :disabled="fusionGate(canExcludePanelist(focusedRun, a.participantId)).disabled"
                    :title="fusionGate(canExcludePanelist(focusedRun, a.participantId)).title"
                    @click="onManagedExclude(a.participantId)"
                  >exclude</UiButton>
                </template>
                <UiButton variant="secondary" size="xs"
                  v-else-if="a.type === 'work_order_approval'"
                  :data-testid="`managed-approve-${a.versionId}`"
                  :disabled="fusionGate(canApproveWorkOrder(focusedRun, a.versionId)).disabled"
                  :title="fusionGate(canApproveWorkOrder(focusedRun, a.versionId)).title"
                  @click="onManagedApproveWo(a.versionId)"
                >approve work order</UiButton>
              </div>
            </div>

            <ManagedRunEvents
              :events="focusedState?.events ?? []"
              :pending="focusedState?.eventsPending ?? false"
              :corrupt="focusedState?.eventsCorrupt ?? 0"
              :total="focusedState?.eventsTotal ?? 0"
            />
            <p v-if="focusedRun.finishedAt" class="managed-sub mono">finished {{ fmtTs(focusedRun.finishedAt) }}</p>
          </template>
        </div>
      </section>

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
.tab-btn { display: flex; align-items: center; gap: 0.3rem; white-space: nowrap; }

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

/* Managed runs (execution API) — visually separate from the porch list. */
.managed {
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  padding: 0.375rem 0.875rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.managed-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.managed-title {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-secondary, #6b6259);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.managed-err {
  font-size: 0.625rem;
  color: var(--text-accent, #c2532f);
}
.managed-row { display: flex; gap: 0.5rem; }
.managed-card {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.managed-run {
  margin-left: auto;
  color: var(--text-muted, #a39a8e);
}
.managed-detail {
  margin-top: 0.25rem;
  padding: 0.375rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-sm, 4px);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.managed-detailhead {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-primary, #2b2723);
}
.managed-sub {
  margin: 0;
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.managed-runsel {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
.managed-sel { max-width: 100%; }
/* F4 fusion badges + pending actions */
.managed-mode {
  color: var(--text-accent, #c2532f);
  border: 1px solid var(--text-accent, #c2532f);
  border-radius: var(--radius-sm, 4px);
  padding: 0 0.25rem;
  font-size: 0.5625rem;
}
.managed-pending {
  color: #fff;
  background: var(--text-accent, #c2532f);
  border-radius: var(--radius-sm, 4px);
  padding: 0 0.25rem;
  font-size: 0.5625rem;
}
.managed-fusion {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.25rem 0;
  border-top: 1px dashed var(--border-faint, rgba(43, 39, 35, 0.09));
}
.managed-action {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.managed-warn {
  color: var(--text-accent, #c2532f);
  font-size: 0.625rem;
  flex: 1;
  min-width: 10rem;
}
</style>
