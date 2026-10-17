<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
import { computed, ref } from 'vue';
import { useActivityStore, type ActivityEntry } from '../../stores/activity';
import { dayKey, fmtCost, fmtNum, fmtTime } from './format';

const activity = useActivityStore();

interface DayRow {
  day: string;
  turns: number;
  tokens: number;
  cost: number;
  sessions: number;
  events: ActivityEntry[];
}

// Last 14 days, newest first. Numbers come from `usageByDay` (the ledger's
// own aggregation); the events column and session count come from the raw
// entries of the same range.
const rows = computed<DayRow[]>(() => {
  const { from, to } = activity.dayRange(14);
  const usageDays = new Map(activity.usageByDay(from, to).map((d) => [d.day, d]));
  const entries = activity.entriesInRange(from, to);

  const byDay = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const k = dayKey(e.at);
    const list = byDay.get(k) ?? [];
    list.push(e);
    byDay.set(k, list);
  }

  const keys = new Set([...usageDays.keys(), ...byDay.keys()]);
  return [...keys]
    .sort((a, b) => b.localeCompare(a))
    .map((day) => {
      const u = usageDays.get(day);
      const events = (byDay.get(day) ?? []).slice().reverse();
      return {
        day,
        turns: u?.turns ?? events.filter((e) => e.kind === 'turn-end').length,
        tokens: u?.tokens ?? 0,
        cost: u?.cost ?? 0,
        sessions: new Set(events.map((e) => e.sessionId).filter(Boolean)).size,
        events,
      };
    });
});

const expanded = ref<Set<string>>(new Set());

function toggle(day: string) {
  const next = new Set(expanded.value);
  if (next.has(day)) next.delete(day);
  else next.add(day);
  expanded.value = next;
}

function isOpen(day: string): boolean {
  return expanded.value.has(day);
}
</script>

<template>
  <div class="timeline-tab">
    <div v-if="rows.length === 0" class="tab-empty" aria-live="polite">
      No activity in the last 14 days. Turns, tool calls and card moves show
      up here once the ledger records them.
    </div>

    <ul v-else class="day-list">
      <li v-for="row in rows" :key="row.day" class="day-item">
        <UiButton variant="row"
          class="day-row"
          :aria-expanded="isOpen(row.day)"
          @click="toggle(row.day)"
        >
          <svg
            class="chev" :class="{ open: isOpen(row.day) }"
            viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span class="day mono">{{ row.day }}</span>
          <span class="num mono" :title="`${row.turns} turns`">{{ row.turns }}t</span>
          <span class="num mono" :title="`${row.tokens} tokens`">{{ fmtNum(row.tokens) }}tok</span>
          <span class="num mono" :title="`cost ${row.cost}`">{{ fmtCost(row.cost) }}</span>
          <span class="num mono" :title="`${row.sessions} sessions touched`">{{ row.sessions }}sess</span>
        </UiButton>

        <ul v-if="isOpen(row.day)" class="day-events">
          <li v-for="e in row.events" :key="e.id" class="event-row">
            <span class="mono etime">{{ fmtTime(e.at) }}</span>
            <span class="kind mono">{{ e.kind }}</span>
            <span class="eagent mono">{{ e.agentName }}</span>
            <span class="etext" :title="[e.title, e.detail].filter(Boolean).join(' — ')">
              {{ [e.title, e.detail].filter(Boolean).join(' — ') || '—' }}
            </span>
          </li>
          <li v-if="row.events.length === 0" class="event-row none">
            usage samples only, no events
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.timeline-tab {
  height: 100%;
  overflow-y: auto;
}

.tab-empty {
  padding: 2rem;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
  text-align: center;
}

.day-list,
.day-events {
  list-style: none;
  margin: 0;
  padding: 0;
}

.day-item {
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.day-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

.chev {
  flex: 0 0 auto;
  color: var(--text-muted, #a39a8e);
  transition: transform 0.12s;
}

.chev.open {
  transform: rotate(90deg);
}

.mono {
  font-family: var(--font-mono, monospace);
}

.day {
  flex: 1;
  font-size: 0.75rem;
  font-weight: 550;
}

.num {
  flex: 0 0 auto;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary, #6b6259);
  min-width: 3.5rem;
  text-align: right;
}

.day-events {
  padding: 0.125rem 0 0.375rem;
}

.event-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 24px;
  padding: 0 0.75rem 0 2rem;
  font-size: 0.6875rem;
}

.event-row.none {
  color: var(--text-muted, #a39a8e);
  font-style: italic;
}

.etime {
  flex: 0 0 auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.kind {
  flex: 0 0 auto;
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-radius: var(--radius-sm, 4px);
  padding: 0 0.3rem;
}

.eagent {
  flex: 0 0 auto;
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}

.etext {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 800px) {

  .num {
    min-width: 0;
  }
}
</style>
