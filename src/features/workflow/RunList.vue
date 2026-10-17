<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
// Run picker: the newest ~20 porch runs as a dense table. Clicking a row
// pins it (disables follow-latest); the header's "latest" control resumes
// following — the mode picks up a new run the moment porch registers one.
import type { PorchRunSummary } from '../../lib/porch/types';

const props = defineProps<{
  runs: PorchRunSummary[];
  selectedRunId: string | null;
  following: boolean;
  now: number;
}>();

const emit = defineEmits<{
  select: [runId: string];
  follow: [];
}>();

/** run_amber-crane-9ab9 → amber-crane-9ab9 — the human part. */
function shortId(runId: string): string {
  return runId.replace(/^run_/, '');
}

/** Last two cwd segments — enough to recognize the project. */
function cwdTail(cwd: string | null): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((props.now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

function rowTitle(run: PorchRunSummary): string {
  return [run.runId, run.cwd].filter(Boolean).join('\n');
}
</script>

<template>
  <section class="run-list" aria-label="Porch runs">
    <div class="run-list-head">
      <span class="run-list-title">runs <span class="mono">{{ props.runs.length }}</span></span>
      <UiButton variant="ghost"
        v-if="!props.following"
        class="follow-btn"
        type="button"
        title="Resume following the newest run — a new porch run opens itself here"
        @click="emit('follow')"
      >follow latest</UiButton>
      <span v-else class="follow-note" title="Newest running run is opened automatically">following latest</span>
    </div>
    <table class="run-table">
      <tbody>
        <tr
          v-for="run in props.runs"
          :key="run.runId"
          :class="{ selected: run.runId === props.selectedRunId }"
          :title="rowTitle(run)"
          @click="emit('select', run.runId)"
        >
          <td class="cell-id mono">{{ shortId(run.runId) }}</td>
          <td class="cell-agent">{{ run.agentId ?? '—' }}</td>
          <td class="cell-backend">{{ run.backend ?? '—' }}</td>
          <td class="cell-status">
            <span class="dot" :class="{ live: run.status === 'running' }" aria-hidden="true" />
            {{ run.status ?? '—' }}
          </td>
          <td class="cell-when mono">{{ relTime(run.startedAt) }}</td>
          <td class="cell-cwd mono">{{ cwdTail(run.cwd) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.run-list {
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  max-height: 168px;
  overflow-y: auto;
  flex: 0 0 auto;
}

.run-list-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 1rem;
  position: sticky;
  top: 0;
  background: var(--bg-main, #fbf8f3);
}
.run-list-title {
  font-size: 0.6875rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}
.mono {
  font-family: var(--font-mono, monospace);
}
.follow-btn {
  margin-left: auto;
}
.follow-note {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.run-table {
  width: 100%;
  border-collapse: collapse;
}
.run-table tr {
  cursor: pointer;
}
.run-table tr:hover td {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}
.run-table tr.selected td {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}
.run-table td {
  padding: 0.125rem 0.375rem;
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-id {
  color: var(--text-primary, #2b2723);
  font-size: 0.6875rem;
  padding-left: 1rem;
}
.cell-status {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
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
.cell-when {
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}
.cell-cwd {
  max-width: 12rem;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  padding-right: 1rem;
}
</style>
