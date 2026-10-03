<script setup lang="ts">
// Shared managed-run event history: renders EVERY event the store drained
// (the store pages through the full canonical history — there is no tail
// cutoff). Each row expands to its recorded payload. Used by the drawer
// execution panel and the Workflow managed detail — one implementation.
import type { ExecRunEvent } from '../../lib/execution/api';
import { fmtTs } from '../../lib/execution/ui-model';

defineProps<{
  events: ExecRunEvent[];
  pending?: boolean;
  corrupt?: number;
  total?: number;
}>();

/** Everything past seq/type/at/ts is the event's recorded payload — show it
 * verbatim inside the expandable row so nothing rendered is invented. */
function eventDetail(e: ExecRunEvent): string | null {
  const { seq: _s, type: _t, at: _a, ts: _t2, ...rest } = e;
  const keys = Object.keys(rest);
  if (!keys.length) return null;
  const only = keys.length === 1 && 'data' in rest ? rest.data : rest;
  try {
    return JSON.stringify(only, null, 2);
  } catch {
    return String(only);
  }
}
</script>

<template>
  <div class="mre-events" data-testid="managed-run-events">
    <p v-if="typeof total === 'number'" class="mre-meta mono">
      {{ events.length }}<template v-if="total !== events.length"> of {{ total }}</template> events
    </p>
    <div v-for="e in events" :key="e.seq" class="mre-event mono">
      <details v-if="eventDetail(e)" class="mre-detail">
        <summary>
          <span class="mre-seq">#{{ e.seq }}</span>
          {{ e.type }}<template v-if="e.at"> · {{ fmtTs(e.at) }}</template>
          <template v-if="e.attemptId"> · {{ e.attemptId }}</template>
        </summary>
        <pre class="mre-payload">{{ eventDetail(e) }}</pre>
      </details>
      <template v-else>
        <span class="mre-seq">#{{ e.seq }}</span>
        {{ e.type }}<template v-if="e.at"> · {{ fmtTs(e.at) }}</template>
        <template v-if="e.attemptId"> · {{ e.attemptId }}</template>
      </template>
    </div>
    <p v-if="pending || corrupt" class="mre-note">
      <template v-if="pending">loading earlier events…</template>
      <template v-if="corrupt"> {{ corrupt }} malformed event lines skipped</template>
    </p>
  </div>
</template>

<style scoped>
.mre-events {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--edge);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--bg-soft, transparent);
}
.mre-meta {
  margin: 0 0 4px;
  font-size: 11px;
  opacity: 0.65;
}
.mre-event {
  font-size: 11px;
  line-height: 1.5;
}
.mre-seq {
  opacity: 0.55;
}
.mre-detail summary {
  cursor: pointer;
}
.mre-payload {
  margin: 2px 0 4px 14px;
  padding: 4px 6px;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-softer, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
  max-height: 160px;
  overflow-y: auto;
}
.mre-note {
  margin: 4px 0 0;
  font-size: 11px;
  opacity: 0.7;
}
</style>
