// Workflow store: polls the state server's read-only porch endpoints and
// projects the selected run's audit.jsonl tail into stepper state.
//
// Model (see PLAN.md §4.5/§5/§7):
//  - the view lists and opens existing runs; it does not dispatch (the
//    state server has no write route — porch runs start on the host via
//    scripts/porch-dispatch). "Auto-trigger" maps to followLatest: while
//    nothing is pinned, the newest running run (else the newest overall)
//    is selected, so a run porch starts appears here on the next poll.
//  - the audit window is re-parsed whole every tick — the server already
//    bounds it to the last 512 KiB, so incremental cursors buy nothing.
//  - staleness is honest silence-detection (meta.updated_at age + audit
//    size delta); the browser cannot prove a pid is dead.
//
// Persists workflow.json: direction (manual override), selectedRunId,
// followLatest.

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { getRun, listRuns, probePorch } from '../lib/porch/api';
import { parseAudit } from '../lib/porch/audit';
import { projectEvents } from '../lib/porch/event-blocks';
import {
  DIRECTIONS,
  NODE_DEFS,
  activeIndex,
  inferDirection,
  matchesNode,
} from '../lib/porch/graph';
import { deriveRunStatus, type RunStatus } from '../lib/porch/status';
import type {
  Direction,
  EventBlock,
  PorchRunDetail,
  PorchRunSummary,
  WfEvent,
} from '../lib/porch/types';

const STORE_PATH = 'workflow.json';
const WORKFLOW_POLL_MS = 2000;
const MAX_RUNS = 20;

export const useWorkflowStore = defineStore('workflow', () => {
  const runs = ref<PorchRunSummary[]>([]);
  const detail = ref<PorchRunDetail | null>(null);
  const events = ref<WfEvent[]>([]);
  const selectedRunId = ref<string | null>(null);
  const followLatest = ref(true);
  /** Manual direction pick; null = follow the selected run's inferred one. */
  const manualDirection = ref<Direction | null>(null);
  const expandedNodeId = ref<string | null>(null);
  const runStatus = ref<RunStatus>('active');
  /** null = not probed yet; false = state server unreachable. */
  const porchUp = ref<boolean | null>(null);
  const errorMessage = ref<string | null>(null);
  const auditTruncated = ref(false);
  const lastAuditSize = ref<number | null>(null);
  /** Ticking clock for elapsed/stale display — refreshed by tick(). */
  const now = ref(Date.now());
  const ready = ref(false);

  let store: KVStore | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  // ---- derived ------------------------------------------------------------

  const selectedSummary = computed<PorchRunSummary | null>(
    () => runs.value.find((r) => r.runId === selectedRunId.value) ?? null,
  );

  /** Direction the stepper actually renders: manual pick wins, else the
   * selected run's artifacts-dir encoding, else `run`. */
  const inferredDirection = computed<Direction>(() =>
    inferDirection(detail.value?.meta ?? null),
  );
  const direction = computed<Direction>(
    () => manualDirection.value ?? inferredDirection.value,
  );
  const nodes = computed(() => NODE_DEFS[direction.value]);

  /** Last node any event matches — the Paseo rule: that node is active,
   * everything before is done, everything after idle. On terminal runs the
   * last-matched node renders done, never active. */
  const terminal = computed(
    () => runStatus.value === 'done' || runStatus.value === 'failed',
  );
  const activeNodeIndex = computed(() => activeIndex(nodes.value, events.value));

  /** Error banner text: meta.error wins (authoritative terminal error);
   * else the latest run_failed-class event (adapter `error` lines like
   * permission_required surface mid-run, before meta catches up). */
  const errorText = computed<string | null>(() => {
    const metaError = detail.value?.meta?.error;
    if (typeof metaError === 'string' && metaError) return metaError;
    for (let i = events.value.length - 1; i >= 0; i--) {
      if (events.value[i].type === 'run_failed') {
        return events.value[i].data ?? 'run failed';
      }
    }
    return null;
  });

  /** "no output for N min" — silence is what stale means here. */
  const staleText = computed<string | null>(() => {
    if (runStatus.value !== 'stale') return null;
    const updated = detail.value?.meta?.updated_at;
    const ms = typeof updated === 'string' ? Date.parse(updated) : NaN;
    if (!Number.isFinite(ms)) return 'no recent output';
    const mins = Math.max(1, Math.round((now.value - ms) / 60_000));
    return `no output for ${mins} min`;
  });

  /** Events matching one node — shared by the count badge and the
   * expanded block list. */
  function eventsFor(nodeId: string): WfEvent[] {
    const def = nodes.value.find((n) => n.id === nodeId);
    if (!def) return [];
    return events.value.filter((e) => matchesNode(e, def));
  }

  const expandedBlocks = computed<EventBlock[]>(() => {
    if (expandedNodeId.value === null) return [];
    return projectEvents(eventsFor(expandedNodeId.value));
  });

  // ---- persistence ----------------------------------------------------------

  async function persist(): Promise<void> {
    if (!store) return;
    await store.set('direction', manualDirection.value);
    await store.set('selectedRunId', selectedRunId.value);
    await store.set('followLatest', followLatest.value);
    await store.save();
  }

  async function initWorkflowStore(): Promise<void> {
    if (ready.value) return;
    store = await loadKvStore(STORE_PATH);
    const dir = await store.get<string>('direction');
    if (dir !== null && (DIRECTIONS as readonly string[]).includes(dir)) {
      manualDirection.value = dir as Direction;
    }
    selectedRunId.value = await store.get<string | null>('selectedRunId');
    followLatest.value = (await store.get<boolean>('followLatest')) ?? true;
    ready.value = true;
  }

  // ---- polling --------------------------------------------------------------

  /** One poll pass: runs list → selection reconcile → selected run detail
   * → parse + derive status. Serialized by `ticking` — a slow fetch never
   * stacks another tick on top. */
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      now.value = Date.now();
      if (!(await probePorch())) {
        porchUp.value = false;
        return;
      }
      porchUp.value = true;
      try {
        runs.value = (await listRuns()).slice(0, MAX_RUNS);
      } catch {
        // Probe passed but the read failed — transient; keep last state and
        // surface it instead of blanking the view.
        errorMessage.value = 'could not read porch runs';
        return;
      }
      errorMessage.value = null;

      if (followLatest.value) {
        // Newest running run wins; else newest overall (list is sorted
        // startedAt desc server-side). A newly appearing run id switches
        // the view to it — the achievable reading of "auto-trigger".
        const pick =
          runs.value.find((r) => r.status === 'running') ?? runs.value[0] ?? null;
        if (pick !== null && pick.runId !== selectedRunId.value) {
          selectRunInternal(pick.runId);
          void persist();
        }
      }

      if (selectedRunId.value === null) {
        detail.value = null;
        events.value = [];
        runStatus.value = 'active';
        return;
      }

      let d: PorchRunDetail | null;
      try {
        d = await getRun(selectedRunId.value);
      } catch {
        errorMessage.value = 'could not read the selected run';
        return;
      }
      if (d === null) {
        // 404 — the run fell out of the registry (or was never real).
        detail.value = null;
        events.value = [];
        return;
      }
      detail.value = d;
      const size = d.audit?.size ?? null;
      const auditGrew = lastAuditSize.value === null || size !== lastAuditSize.value;
      lastAuditSize.value = size;
      events.value = parseAudit(d.audit?.text ?? '', d.meta);
      runStatus.value = deriveRunStatus(d, now.value, { auditGrew });
      auditTruncated.value = d.audit?.truncated ?? false;
    } finally {
      ticking = false;
    }
  }

  function selectRunInternal(runId: string): void {
    if (selectedRunId.value === runId) return;
    selectedRunId.value = runId;
    lastAuditSize.value = null;
  }

  function startPolling(): void {
    if (timer !== null) return;
    void tick();
    timer = setInterval(() => void tick(), WORKFLOW_POLL_MS);
  }

  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ---- actions ----------------------------------------------------------------

  /** Pin a run — disables follow-latest until resumeFollow(). */
  function selectRun(runId: string): void {
    followLatest.value = false;
    selectRunInternal(runId);
    void persist();
    void tick();
  }

  /** Re-enable follow-latest (the "auto-trigger" behavior). */
  function resumeFollow(): void {
    followLatest.value = true;
    void persist();
    void tick();
  }

  /** Pick a direction manually; clicking the active direction clears the
   * override and returns to following the run's inferred direction. */
  function setDirection(d: Direction): void {
    manualDirection.value = manualDirection.value === d ? null : d;
    void persist();
  }

  function toggleNode(nodeId: string): void {
    expandedNodeId.value = expandedNodeId.value === nodeId ? null : nodeId;
  }

  return {
    runs,
    detail,
    events,
    selectedRunId,
    selectedSummary,
    followLatest,
    manualDirection,
    direction,
    nodes,
    activeNodeIndex,
    terminal,
    expandedNodeId,
    expandedBlocks,
    runStatus,
    errorText,
    staleText,
    errorMessage,
    auditTruncated,
    porchUp,
    now,
    ready,
    initWorkflowStore,
    tick,
    startPolling,
    stopPolling,
    selectRun,
    resumeFollow,
    setDirection,
    eventsFor,
    toggleNode,
  };
});
