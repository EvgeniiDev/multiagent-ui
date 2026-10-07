<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiExpandableRows from './ui/UiExpandableRows.vue';
import UiUsageTable, { type UsageTableRow } from './ui/UiUsageTable.vue';
import { useActivityStore, projectName } from '../stores/activity';
import { useSessionStore } from '../stores/session';
import { useLimitsStore, periodStart, periodLabel, type UsageLimit } from '../stores/limits';
import { useUiStore } from '../stores/ui';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { RANGES, rangeBounds, rangeLabel, type RangeId } from '../features/dashboard/range';
import { fmtInt, fmtCompact, fmtCostGroups, fmtTokensWithEst, shortDate, fmtStamp, fmtAgo } from '../features/dashboard/format';
import { aggregateUsage, localDayKey, type UsageGroup } from '../features/dashboard/aggregate';
import { exportFileName, toJson, toCsv, downloadFile, type ExportPayload } from '../features/dashboard/exportData';

const activity = useActivityStore();
const sessionStore = useSessionStore();
const limitsStore = useLimitsStore();
const uiStore = useUiStore();
const now = ref(Date.now());
const range = ref<RangeId>('7d');
const rangeLoading = ref(false);
let prefs: KVStore | null = null;
const selectedBucket = ref<string | null>(null);
const query = ref('');
type BreakdownId = 'models' | 'projects' | 'agents' | 'sessions' | 'days';
const activeBreakdown = ref<BreakdownId>('models');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const bounds = computed(() => {
  const window = rangeBounds(range.value, now.value);
  if (range.value === 'all') {
    const rows = activity.usageInRange(0, now.value);
    if (rows.length) window.from = rows.reduce((at, r) => Math.min(at, r.at), now.value);
  }
  return window;
});
const windowLabel = computed(() => rangeLabel(range.value, bounds.value.from, bounds.value.to));
const periodRows = computed(() => activity.deltaRows(bounds.value.from, bounds.value.to));
const periodEntries = computed(() => activity.entriesInRange(bounds.value.from, bounds.value.to));
const periodStats = computed(() => aggregateUsage(periodRows.value, periodEntries.value, activity.usageSources));
const scalarCost = (r: UsageGroup) => r.costs.length === 1 ? r.costs[0].amount : null;

interface DayPoint {
  day: string; label: string; from: number; to: number; step: number;
  tokens: number; estTokens: number; cost: number; turns: number; costs: string;
  costGroups: UsageGroup['costs'];
}
const dayPoints = computed<DayPoint[]>(() => {
  const { from, to } = bounds.value;
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(0, 0, 0, 0);
  const step = (end.getTime() - start.getTime()) / 86400000 > 119 ? 7 : 1;
  const byDay = new Map(periodStats.value.days.map(r => [r.key, r]));
  const out: DayPoint[] = [];
  for (let d = new Date(start); d <= end;) {
    const next = new Date(d); next.setDate(next.getDate() + step);
    const finalDay = new Date(next); finalDay.setDate(finalDay.getDate() - 1);
    const day = localDayKey(d.getTime());
    const costs = new Map<string, number>();
    let tokens = 0, estTokens = 0, turns = 0;
    for (let cursor = new Date(d); cursor < next; cursor.setDate(cursor.getDate() + 1)) {
      const r = byDay.get(localDayKey(cursor.getTime()));
      if (!r) continue;
      tokens += r.tokens; estTokens += r.estTokens; turns += r.turns;
      for (const c of r.costs) costs.set(c.currency, (costs.get(c.currency) ?? 0) + c.amount);
    }
    const costGroups = [...costs].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
    out.push({ day, label: step === 1 ? shortDate(day) : `${shortDate(day)} – ${shortDate(localDayKey(finalDay.getTime()))}`,
      from: d.getTime(), to: next.getTime() - 1, step, tokens, estTokens, turns,
      cost: costGroups.reduce((n, c) => n + c.amount, 0), costs: fmtCostGroups(costGroups), costGroups });
    d = next;
  }
  return out;
});
const tableRows = computed(() => dayPoints.value.filter(d => d.tokens > 0 || d.costGroups.length || d.turns > 0).slice().reverse());
const selectedPoint = computed(() => dayPoints.value.find(d => d.day === selectedBucket.value));
const selectionBounds = computed(() => selectedPoint.value
  ? { from: Math.max(bounds.value.from, selectedPoint.value.from), to: Math.min(bounds.value.to, selectedPoint.value.to) }
  : bounds.value);
const selectedSpendRows = computed(() => {
  if (!selectedPoint.value) return periodRows.value;
  const { from, to } = selectionBounds.value;
  return periodRows.value.filter(r => r.at >= from && r.at <= to);
});
const selectionStats = computed(() => {
  if (!selectedPoint.value) return periodStats.value;
  const { from, to } = selectionBounds.value;
  return aggregateUsage(selectedSpendRows.value,
    periodEntries.value.filter(r => r.at >= from && r.at <= to), activity.usageSources);
});
const summary = computed(() => selectionStats.value.total);
const initialLoading = computed(() => activity.usageLoading && !activity.usageSources.length);
const hasMissingCosts = computed(() => selectedSpendRows.value.some(r => typeof r.cost !== 'number' || !Number.isFinite(r.cost)));
const availableHistories = computed(() => activity.usageSources.filter(s => s.status !== 'unavailable').length);
const chartBucketLabel = computed(() => dayPoints.value[0]?.step === 7 ? 'Weekly totals' : 'Daily totals');
const peakPoint = computed(() => dayPoints.value.reduce<DayPoint | null>((peak, d) => !peak || d.tokens > peak.tokens ? d : peak, null));
const inspectorTitle = computed(() => selectedPoint.value ? `${selectedPoint.value.step === 7 ? 'Week of ' : ''}${selectedPoint.value.label}` : 'Full period');
const inspectorDates = computed(() => selectedPoint.value
  ? `${localDayKey(selectionBounds.value.from)}${selectedPoint.value.step === 7 ? ` — ${localDayKey(selectionBounds.value.to)}` : ''}`
  : `${new Date(bounds.value.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — ${new Date(bounds.value.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);

const sessionScope = ref<{ model: string; provider: string } | { agentName: string } | null>(null);
const sessionDetailKey = ref<string | null>(null);
const sessionStats = computed(() => {
  const scope = sessionScope.value;
  if (!scope) return selectionStats.value;
  const rows = selectedSpendRows.value.filter(r => 'model' in scope
    ? r.model === scope.model && r.provider === scope.provider : r.agentName === scope.agentName);
  // A model's contribution is filtered before grouping: mixed-model sessions
  // must not contribute their other models' tokens to this drilldown.
  return aggregateUsage(rows, [], []);
});
const scopeLabel = computed(() => !sessionScope.value ? '' : 'model' in sessionScope.value
  ? `${sessionScope.value.model} · ${sessionScope.value.provider}` : sessionScope.value.agentName);
const sessionDetail = computed(() => sessionStats.value.sessions.find(r => r.key === sessionDetailKey.value));
const detailSaved = computed(() => sessionDetail.value && sessionStore.savedSessions.find(s =>
  s.agentName === sessionDetail.value?.agentName && s.sessionId === sessionDetail.value?.sessionId));
const detailModels = computed(() => sessionDetail.value ? aggregateUsage(selectedSpendRows.value.filter(r =>
  r.agentName === sessionDetail.value?.agentName && r.sessionId === sessionDetail.value?.sessionId &&
  (!sessionScope.value || !('model' in sessionScope.value) ||
    (r.model === sessionScope.value.model && r.provider === sessionScope.value.provider))), [], []).models : []);
watch([selectedBucket, range], () => { sessionDetailKey.value = null; });
const savedSessionsByKey = computed(() => new Map(sessionStore.savedSessions.map(s => [`${s.agentName}::${s.sessionId}`, s])));
const tabs = computed(() => [
  { id: 'models' as const, label: 'Models', title: 'Models & providers', nameLabel: 'Model', detailLabel: 'Provider', tableId: 'by-model-table', rowId: 'by-model-row', count: selectionStats.value.models.length },
  { id: 'projects' as const, label: 'Projects', title: 'Projects', nameLabel: 'Project', detailLabel: 'Type', tableId: 'by-project-table', rowId: 'by-project-row', count: selectionStats.value.projects.length },
  { id: 'agents' as const, label: 'Agents', title: 'By agent', nameLabel: 'Agent', detailLabel: 'Coverage', tableId: 'by-agent-table', rowId: 'by-agent-row', count: selectionStats.value.agents.length },
  { id: 'sessions' as const, label: 'Sessions', title: 'Sessions', nameLabel: 'Session', detailLabel: 'Agent / project', tableId: 'top-sessions-table', rowId: 'top-session-row', count: sessionStats.value.sessions.length },
  { id: 'days' as const, label: 'Days', title: 'Days, newest first', nameLabel: 'Day / week', detailLabel: 'Date', tableId: 'by-day-table', rowId: 'by-day-row', count: selectedPoint.value ? 1 : tableRows.value.length },
]);
const activeTab = computed(() => tabs.value.find(t => t.id === activeBreakdown.value)!);
const activeRows = computed<UsageTableRow[]>(() => {
  const total = activeBreakdown.value === 'sessions' ? sessionStats.value.total.tokens : summary.value.tokens;
  if (activeBreakdown.value === 'days') {
    return (selectedPoint.value ? [selectedPoint.value] : tableRows.value).map(d => ({ key: d.day, day: d.day,
      name: d.label, detail: d.day, tokens: d.tokens, estTokens: d.estTokens, costs: d.costs,
      share: total > 0 ? d.tokens / total * 100 : 0 }));
  }
  const groups = activeBreakdown.value === 'sessions' ? sessionStats.value.sessions : selectionStats.value[activeBreakdown.value];
  return groups.map(r => ({ ...r,
    name: activeBreakdown.value === 'sessions' ? savedSessionsByKey.value.get(r.key)?.title || r.name : r.name,
    title: activeBreakdown.value === 'sessions' ? `${r.sessionId} · ${r.cwd || ''}` : r.cwd || r.name,
    actionLabel: activeBreakdown.value === 'models' ? `View sessions for ${r.name}, ${r.detail}`
      : activeBreakdown.value === 'sessions' ? `Inspect session ${r.sessionId}` : undefined,
    costs: fmtCostGroups(r.costs), share: total > 0 ? r.tokens / total * 100 : 0,
    canResume: activeBreakdown.value === 'sessions' && savedSessionsByKey.value.has(r.key) }));
});
const filteredRows = computed(() => {
  const search = query.value.trim().toLowerCase();
  return search ? activeRows.value.filter(r => `${r.name} ${r.detail} ${r.title ?? ''}`.toLowerCase().includes(search)) : activeRows.value;
});
function selectTab(id: BreakdownId): void {
  activeBreakdown.value = id; query.value = ''; sessionScope.value = null; sessionDetailKey.value = null;
}
async function inspectRow(key: string): Promise<void> {
  if (activeBreakdown.value === 'models') {
    const model = selectionStats.value.models.find(r => r.key === key);
    if (!model || model.model === undefined || model.provider === undefined) return;
    sessionScope.value = { model: model.model, provider: model.provider };
    activeBreakdown.value = 'sessions'; query.value = ''; sessionDetailKey.value = null;
    await nextTick(); document.getElementById('session-scope')?.focus();
  } else if (activeBreakdown.value === 'sessions') {
    sessionDetailKey.value = key;
    await nextTick(); document.getElementById('session-detail')?.focus();
  }
}
async function inspectAgent(name: string): Promise<void> {
  sessionScope.value = { agentName: name }; activeBreakdown.value = 'sessions';
  query.value = ''; sessionDetailKey.value = null;
  await nextTick(); document.getElementById('session-scope')?.focus();
}
async function onTabsKeydown(event: KeyboardEvent): Promise<void> {
  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const ids = tabs.value.map(t => t.id), current = ids.indexOf(activeBreakdown.value);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
    : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + ids.length) % ids.length;
  selectTab(ids[next]); await nextTick(); document.getElementById(`tab-${ids[next]}`)?.focus();
}
async function openSession(key: string): Promise<void> {
  const row = selectionStats.value.sessions.find(r => r.key === key);
  const saved = row && sessionStore.savedSessions.find(s => s.sessionId === row.sessionId && s.agentName === row.agentName);
  if (!saved) return;
  try { await sessionStore.resumeSession(saved); await uiStore.setView('chat'); }
  catch (e) { console.warn('Resume from dashboard failed:', e); }
}
watch(dayPoints, () => { if (selectedBucket.value && !selectedPoint.value) selectedBucket.value = null; });

const chartSvg = ref<SVGSVGElement | null>(null);
const chartWidth = ref(640);
const chartHeight = computed(() => chartWidth.value < 500 ? 190 : 240);
const PAD_L = 42, PAD_B = 28, PAD_T = 8;
const compactTokens = (n: number) => n >= 1e9 ? `${Number((n / 1e9).toFixed(2))}B` : fmtCompact(n);
let chartObserver: ResizeObserver | null = null;
watch(chartSvg, svg => {
  chartObserver?.disconnect();
  if (!svg) return;
  const measure = () => { chartWidth.value = Math.max(260, svg.getBoundingClientRect().width); };
  measure(); chartObserver = new ResizeObserver(measure); chartObserver.observe(svg);
});
const maxDayTokens = computed(() => dayPoints.value.reduce((max, d) => Math.max(max, d.tokens), 0));
const chartGeom = computed(() => {
  const n = dayPoints.value.length, max = Math.max(maxDayTokens.value, 1);
  const plotW = chartWidth.value - PAD_L - 8, plotH = chartHeight.value - PAD_T - PAD_B;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, Math.min(28, slot * .7));
  return dayPoints.value.map((d, i) => {
    const h = Math.max(d.tokens ? 2 : 0, d.tokens / max * plotH);
    const hEst = Math.min(d.estTokens / max * plotH, h), hFact = h - hEst;
    return { x: PAD_L + slot * i + (slot - barW) / 2, hitX: PAD_L + slot * i, hitW: slot,
      y: PAD_T + plotH - h, w: barW, h, yFact: PAD_T + plotH - hFact, hFact,
      yEst: PAD_T + plotH - h, hEst };
  });
});
function yTicks(): number[] {
  const max = maxDayTokens.value; if (!max) return [0];
  const raw = max / 3, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks = [0]; for (let n = step; n <= max * 1.05; n += step) ticks.push(n); return ticks;
}
const yFor = (n: number) => PAD_T + (chartHeight.value - PAD_T - PAD_B) * (1 - n / Math.max(maxDayTokens.value, 1));
const chartFocus = ref<number | null>(null);
watch(dayPoints, () => { chartFocus.value = null; });
function toggleBucket(day: string): void { selectedBucket.value = selectedBucket.value === day ? null : day; }
async function onBarKeydown(event: KeyboardEvent, index: number): Promise<void> {
  if (['Enter', ' '].includes(event.key)) { event.preventDefault(); toggleBucket(dayPoints.value[index].day); return; }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const last = dayPoints.value.length - 1;
  chartFocus.value = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, index + (event.key === 'ArrowRight' ? 1 : -1)));
  await nextTick(); document.getElementById(`bar-${dayPoints.value[chartFocus.value].day}`)?.focus();
}
// --- Limits ---
const showLimitForm = ref(false);
const editingId = ref<string | null>(null);
const limitForm = ref({ label: '', scope: 'global' as 'agent' | 'project' | 'global', target: '', period: 'day' as 'day' | 'week' | 'month', targetTokens: 100000 });

function limitUsage(l: UsageLimit, nowMs: number): number {
  const from = periodStart(l.period, nowMs);
  // Quotas compare against what was actually consumed in the period — the
  // per-session delta, not the sum of every running-total sample.
  return activity
    .deltaRows(from, nowMs)
    .filter((r) =>
      l.scope === 'global'
        ? true
        : l.scope === 'agent'
          ? r.agentName === l.target
          : projectName(r.cwd) === l.target
    )
    .reduce((s, r) => s + r.tokens, 0);
}

const limitRows = computed(() =>
  limitsStore.limits.map((l) => {
    const used = limitUsage(l, now.value);
    const pct = l.targetTokens > 0 ? (used / l.targetTokens) * 100 : 0;
    return { limit: l, used, pct, warn: pct > 90 };
  })
);

function startAddLimit(): void {
  editingId.value = null;
  limitForm.value = { label: '', scope: 'global', target: '', period: 'day', targetTokens: 100000 };
  showLimitForm.value = true;
}

function startEditLimit(l: UsageLimit): void {
  editingId.value = l.id;
  limitForm.value = { label: l.label, scope: l.scope, target: l.target, period: l.period, targetTokens: l.targetTokens };
  showLimitForm.value = true;
}

async function saveLimit(): Promise<void> {
  const f = limitForm.value;
  if (!f.label.trim() || !(f.targetTokens > 0)) return;
  if (f.scope !== 'global' && !f.target.trim()) return;
  if (editingId.value) {
    await limitsStore.updateLimit(editingId.value, {
      label: f.label.trim(),
      scope: f.scope,
      target: f.target.trim(),
      period: f.period,
      targetTokens: Math.round(f.targetTokens),
    });
  } else {
    await limitsStore.addLimit({
      label: f.label.trim(),
      scope: f.scope,
      target: f.target.trim(),
      period: f.period,
      targetTokens: Math.round(f.targetTokens),
    });
  }
  showLimitForm.value = false;
  editingId.value = null;
}

async function deleteLimit(id: string): Promise<void> {
  if (confirm('Delete this quota?')) await limitsStore.removeLimit(id);
}

// --- Export ---
function payload(): ExportPayload {
  const { from, to } = bounds.value;
  const total = periodStats.value.total;
  return {
    exportedAt: new Date(now.value).toISOString(), range: range.value,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    summary: { tokens: total.tokens, cost: scalarCost(total), turns: total.turns,
      sessions: total.sessions, toolCalls: total.toolCalls, costs: total.costs },
    byAgent: periodStats.value.agents.map(r => ({ agentName: r.name, tokens: r.tokens,
      cost: scalarCost(r), turns: r.turns, costs: r.costs })),
    byDay: tableRows.value.map(d => ({ day: d.day, tokens: d.tokens, cost: d.costGroups.length === 1 ? d.costGroups[0].amount : null, turns: d.turns, costs: d.costGroups })),
  };
}

function exportJson(): void {
  const p = payload();
  downloadFile(exportFileName(range.value, bounds.value.to, 'json'), toJson(p), 'application/json');
}

function exportCsv(): void {
  const p = payload();
  downloadFile(exportFileName(range.value, bounds.value.to, 'csv'), toCsv(p.byDay), 'text/csv');
}

// Historical activity uses the same native deltas and date selection as usage.
const agentStates = computed(() => {
  const counts = new Map<string, number>();
  for (const session of selectionStats.value.sessions) {
    const name = session.agentName!; counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return selectionStats.value.agents.map(a => ({ name: a.name, tokens: a.tokens,
    sessions: counts.get(a.name) ?? 0, lastAt: a.lastAt,
    inFlight: sessionStore.currentSession?.agentName === a.name && sessionStore.isLoading }));
});

async function setRange(id: RangeId): Promise<void> {
  selectedBucket.value = null;
  chartFocus.value = null;
  range.value = id;
  rangeLoading.value = true;
  // Let the aria-live region announce before the (synchronous) recompute paints.
  await new Promise((r) => setTimeout(r, 30));
  if (prefs) {
    await prefs.set('dashboardRange', id);
    await prefs.save();
  }
  now.value = Date.now();
  rangeLoading.value = false;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  chartObserver?.disconnect();
});

onMounted(async () => {
  prefs = await loadKvStore('preferences.json');
  const saved = await prefs.get<RangeId>('dashboardRange');
  if (saved && RANGES.some((r) => r.id === saved)) range.value = saved;
  await limitsStore.initLimitsStore();
  void activity.refreshNativeUsage();
  tickTimer = setInterval(() => {
    now.value = Date.now();
    void activity.refreshNativeUsage();
  }, 60000);
});

watch(
  () => activity.entries.length,
  () => {
    now.value = Date.now();
  }
);
</script>

<template>
  <div class="view-pane" data-testid="dashboard">
    <div class="pane-body">
      <div class="dashboard-content">
        <header class="dashboard-header">
          <div><div class="breadcrumb">ACP / Analytics</div><h2>Usage &amp; spend</h2><p class="subtitle">Understand where your agent usage goes.</p></div>
          <details class="export-menu">
            <summary>Export data <span aria-hidden="true">↗</span></summary>
            <div class="export-options"><UiButton data-testid="export-csv" @click="exportCsv">Download CSV</UiButton><UiButton data-testid="export-json" @click="exportJson">Download JSON</UiButton><p>Full time range, including hidden rows.</p></div>
          </details>
        </header>

        <div class="period-toolbar">
          <div class="range-seg" role="group" aria-label="Time range" data-testid="range-selector">
            <UiButton v-for="r in RANGES" :key="r.id" variant="ghost" class="range-choice" :aria-pressed="range === r.id" :data-testid="`range-${r.id}`" @click="setRange(r.id)">{{ r.id === 'all' ? 'All time' : r.label }}</UiButton>
          </div>
          <span class="period-label" data-testid="range-label">{{ windowLabel }}</span>
          <span class="sr-only" aria-live="polite">{{ rangeLoading ? 'Updating period…' : '' }}</span>
        </div>
        <p v-if="activity.usageLoading" class="notice" role="status" data-testid="usage-loading">{{ initialLoading ? 'Loading usage from your agents…' : 'Refreshing usage…' }}</p>
        <div v-if="activity.usageError" class="notice notice-error" role="alert" data-testid="usage-error"><span>{{ activity.usageError }}. Showing available ledger data.</span><UiButton size="xs" @click="activity.refreshNativeUsage()">Try again</UiButton></div>

        <div class="analysis-shell">
          <nav class="analysis-menu" aria-label="Usage breakdown">
            <span class="menu-label">Breakdown</span>
            <div class="breakdown-tabs" role="tablist" aria-label="Usage breakdown" @keydown="onTabsKeydown">
              <UiButton v-for="tab in tabs" :key="tab.id" variant="ghost" role="tab" class="breakdown-tab"
                :id="`tab-${tab.id}`" :aria-selected="activeBreakdown === tab.id" :aria-controls="`breakdown-${tab.id}`" :tabindex="activeBreakdown === tab.id ? 0 : -1"
                :data-testid="`tab-${tab.id}`" @click="selectTab(tab.id)"><span>{{ tab.label }}</span><span class="tab-count">{{ fmtInt(tab.count) }}</span></UiButton>
            </div>
            <p class="menu-note">Chats, subagents and background runs.<br /><br />{{ selectedPoint ? 'The breakdown shows the period selected on the chart.' : 'Showing the full time range. Select a bar to inspect a day or week.' }}</p>
          </nav>

          <div class="analysis-main">
            <section class="time-layout" aria-label="Token activity">
              <div class="chart-panel">
                <div class="panel-heading"><div><h3>Explore your usage over time</h3><p>{{ chartBucketLabel }} · select a bar to inspect that period</p></div><span class="chart-unit">Tokens</span></div>
                <div v-if="initialLoading" class="chart-empty" aria-hidden="true">Loading your usage history…</div>
                <div v-else-if="!maxDayTokens" class="chart-empty" data-testid="day-empty">No token usage in this period.<span>Try a wider time range or check the connected histories.</span></div>
                <svg v-else ref="chartSvg" :viewBox="`0 0 ${chartWidth} ${chartHeight}`" class="chart" role="group" :aria-label="`Token activity. ${chartBucketLabel} in ${timeZone}. Use arrow keys to move between bars and Enter to select.`" data-testid="day-chart">
                  <g v-for="t in yTicks()" :key="t" aria-hidden="true"><line :x1="PAD_L" :x2="chartWidth - 8" :y1="yFor(t)" :y2="yFor(t)" class="grid" /><text :x="PAD_L - 6" :y="yFor(t) + 3.5" text-anchor="end" class="axis">{{ compactTokens(t) }}</text></g>
                  <g v-for="(d, i) in dayPoints" :key="d.day" :id="`bar-${d.day}`" class="chart-bucket" :class="{ selected: selectedBucket === d.day }" role="button"
                    :tabindex="(chartFocus ?? dayPoints.length - 1) === i ? 0 : -1" :aria-pressed="selectedBucket === d.day" :aria-label="`${d.day}: ${fmtTokensWithEst(d.tokens, d.estTokens)} tokens${d.step === 7 ? ', week' : ''}`"
                    :data-testid="`bucket-${d.day}`" @focus="chartFocus = i" @click="toggleBucket(d.day)" @keydown="onBarKeydown($event, i)">
                    <title>{{ d.label }}: {{ fmtTokensWithEst(d.tokens, d.estTokens) }} tokens</title>
                    <rect :x="chartGeom[i].hitX" :y="PAD_T" :width="chartGeom[i].hitW" :height="chartHeight - PAD_T - PAD_B" class="bar-hit" />
                    <rect v-if="chartGeom[i].hEst > 0" :x="chartGeom[i].x" :y="chartGeom[i].yEst" :width="chartGeom[i].w" :height="chartGeom[i].hEst" class="bar-rect bar-est" data-testid="day-bar-est" :data-day="d.day" :data-tokens="d.estTokens" />
                    <rect :x="chartGeom[i].x" :y="chartGeom[i].hEst > 0 ? chartGeom[i].yFact : chartGeom[i].y" :width="chartGeom[i].w" :height="chartGeom[i].hEst > 0 ? chartGeom[i].hFact : chartGeom[i].h" rx="2" class="bar-rect" data-testid="day-bar" :data-day="d.day" :data-tokens="d.tokens" />
                  </g>
                  <g v-for="(d, i) in dayPoints" :key="'axis-' + d.day" aria-hidden="true"><text v-if="i % Math.max(1, Math.ceil(dayPoints.length / 6)) === 0" :x="chartGeom[i].x + chartGeom[i].w / 2" :y="chartHeight - 6" text-anchor="middle" class="axis">{{ shortDate(d.day) }}</text></g>
                </svg>
                <div class="chart-footer"><p v-if="peakPoint?.tokens">Peak period <strong>{{ peakPoint.label }} · {{ compactTokens(peakPoint.tokens) }} tokens</strong><span class="chart-zone">{{ timeZone }}</span></p><label class="inspect-select"><span class="sr-only">Inspect a day or week</span><select v-model="selectedBucket" class="ui-input" data-testid="inspect-period" aria-label="Inspect a day or week"><option :value="null">Full period</option><option v-for="d in dayPoints.slice().reverse()" :key="d.day" :value="d.day">{{ d.step === 7 ? 'Week of ' : '' }}{{ d.label }} · {{ compactTokens(d.tokens) }}</option></select></label></div>
              </div>

              <aside class="inspector" aria-label="Selected period summary" data-testid="summary-strip" :aria-busy="initialLoading" aria-live="polite">
                <div><h4 data-testid="inspector-title">{{ inspectorTitle }}</h4><p class="inspector-dates">{{ inspectorDates }}</p></div>
                <dl class="inspector-metrics">
                  <div><dt>Tokens used</dt><dd class="metric-value">{{ initialLoading ? '—' : `${summary.estTokens >= summary.tokens && summary.estTokens > 0 ? '~' : ''}${compactTokens(summary.tokens)}` }}</dd><dd class="metric-exact mono" data-testid="sum-tokens" :data-est="summary.estTokens > 0">{{ initialLoading ? '—' : fmtTokensWithEst(summary.tokens, summary.estTokens) }}</dd><dd class="metric-caption">Includes cached input</dd></div>
                  <div><dt>Reported cost <span v-if="hasMissingCosts" class="muted">· partial</span></dt><dd class="metric-value metric-money" data-testid="sum-cost">{{ initialLoading ? '—' : fmtCostGroups(summary.costs) }}</dd><dd v-if="hasMissingCosts" class="metric-caption">Some costs are unavailable</dd></div>
                  <div><dt>Sessions</dt><dd class="metric-value" data-testid="sum-sessions">{{ initialLoading ? '—' : fmtInt(summary.sessions) }}</dd></div>
                </dl>
                <UiButton v-if="selectedPoint" variant="ghost" size="xs" data-testid="clear-selection" @click="selectedBucket = null">← Back to full period</UiButton>
              </aside>
            </section>

            <div v-if="activity.usageSources.length" class="coverage-strip" data-testid="usage-sources">
              <div class="coverage-copy"><span class="coverage-dot" aria-hidden="true"></span><span>{{ availableHistories }} agent histories connected</span><span v-if="activity.porchUsage?.status === 'ready'" class="coverage-tag">Porch included</span></div>
              <details class="coverage-details"><summary>About these numbers</summary><div class="coverage-body"><p>Includes server sessions, CLI, subagents and background runs.</p><ul><li v-for="source in activity.usageSources" :key="source.agentName">{{ source.agentName }} <span class="muted">{{ source.status === 'ready' ? 'available' : source.status }}</span></li></ul><p v-if="activity.porchUsage?.status === 'ready'">{{ activity.porchUsage.rawFiles }} Porch journals included, covering ephemeral runs.</p><p v-else-if="activity.porchUsage">Porch coverage is {{ activity.porchUsage.status }}. Some ephemeral runs may be missing.</p><p>Costs are shown only when reported by providers. Unavailable costs are excluded from the total; currencies stay separate.</p><p>Hermes history is dated by each session’s last activity, so its daily totals are approximate.</p><p data-testid="usage-legend">Exact counts come from agents. <strong>~</strong> marks a bridge estimate based on message length.</p><p>ACP activity log: <span data-testid="sum-turns">{{ fmtInt(summary.turns) }}</span> recorded turns · <span data-testid="sum-tools">{{ fmtInt(summary.toolCalls) }}</span> tool calls. Native histories may contain additional turns.</p></div></details>
            </div>

            <section :id="`breakdown-${activeBreakdown}`" role="tabpanel" :aria-labelledby="`tab-${activeBreakdown}`" tabindex="0" class="panel explore-panel">
              <div class="panel-heading"><div><h3>{{ activeTab.title }}</h3><p>{{ activeBreakdown === 'days' ? 'Newest periods first' : 'Largest usage first' }} · {{ selectedPoint ? inspectorTitle : 'full selected period' }}</p></div></div>
              <div v-if="activeBreakdown === 'sessions' && sessionScope" id="session-scope" tabindex="-1" class="session-scope" data-testid="session-scope">
                <div><strong>{{ scopeLabel }}</strong><p>{{ fmtInt(sessionStats.total.tokens) }} tokens · {{ sessionStats.sessions.length }} sessions · {{ inspectorDates }}</p><p>Only this {{ 'model' in sessionScope ? 'model’s' : 'agent’s' }} usage in the selected period. Shares are of this subtotal.</p></div>
                <UiButton size="xs" @click="selectTab('models')">← All models</UiButton>
              </div>
              <section v-if="activeBreakdown === 'sessions' && sessionDetail" id="session-detail" tabindex="-1" class="session-detail" data-testid="session-detail" aria-label="Session usage details">
                <div class="panel-heading"><h3>{{ detailSaved?.title || sessionDetail.name }}</h3><UiButton size="xs" @click="sessionDetailKey = null">Close details</UiButton></div>
                <dl><dt>Session ID</dt><dd class="mono">{{ sessionDetail.sessionId }}</dd><dt>Agent</dt><dd>{{ sessionDetail.agentName }}</dd><dt>Project / folder</dt><dd>{{ sessionDetail.cwd || 'Unknown' }}</dd><dt>Selected period</dt><dd>{{ inspectorDates }}</dd><dt>Tokens in this selection</dt><dd>{{ fmtTokensWithEst(sessionDetail.tokens, sessionDetail.estTokens) }}</dd><dt>Last usage in this selection</dt><dd>{{ fmtStamp(sessionDetail.lastAt) }}</dd></dl>
                <ul><li v-for="model in detailModels" :key="model.key">{{ model.name }} · {{ model.provider }}: <strong>{{ fmtInt(model.tokens) }}</strong> tokens</li></ul>
                <UiButton v-if="detailSaved" data-testid="open-saved-chat" @click="openSession(sessionDetail.key)">Open saved chat</UiButton>
                <p v-else class="muted">Historical session from agent logs. This chat is not saved in this browser.</p>
              </section>
              <label class="search-field"><span class="sr-only">Search {{ activeTab.label.toLowerCase() }}</span><input v-model="query" type="search" class="ui-input" :placeholder="`Find ${activeTab.label.toLowerCase()}…`" :aria-label="`Search ${activeTab.label.toLowerCase()}`" data-testid="usage-search" /></label>
              <UiExpandableRows v-if="filteredRows.length" :key="`${activeBreakdown}-${range}-${selectedBucket ?? 'full'}-${scopeLabel}`" :rows="filteredRows" :controls-id="`dashboard-${activeBreakdown}`" :toggle-test-id="`toggle-${activeBreakdown}`" :ordered-by-rank="activeBreakdown !== 'days'" :collapsed-label="activeBreakdown === 'days' ? 'Show latest 20' : undefined" show-count v-slot="{ rows: visibleRows }">
                <UiUsageTable :id="`dashboard-${activeBreakdown}`" :rows="visibleRows" :test-id="activeTab.tableId" :row-test-id="activeTab.rowId" :caption="`${activeTab.title}, ${inspectorTitle}`" :name-label="activeTab.nameLabel" :detail-label="activeTab.detailLabel" @open="inspectRow" />
              </UiExpandableRows>
              <p v-else class="empty" :data-testid="`${activeBreakdown}-empty`">{{ query.trim() ? 'No matching results. Try another search.' : initialLoading ? 'Loading your usage history…' : 'No recorded usage in this period.' }}</p>
            </section>

            <div class="secondary-grid">
<details class="secondary-panel" data-testid="agent-state"><summary>Agent activity <span>{{ summary.sessions }} sessions · {{ inspectorTitle }}</span></summary><div class="secondary-body">

        <p v-if="agentStates.length === 0" class="empty">No agent history in this period.</p>
        <UiExpandableRows v-else :rows="agentStates" controls-id="dashboard-agent-state" toggle-test-id="toggle-agent-state" :ordered-by-rank="false" v-slot="{ rows: visibleRows }">
          <ul id="dashboard-agent-state" class="state-list">
            <li v-for="a in visibleRows" :key="a.name" class="state-row" data-testid="agent-history-row">
                <span class="state-name">{{ a.name }}</span>
              <UiButton size="xs" variant="ghost" :disabled="!a.sessions" @click="inspectAgent(a.name)">{{ a.sessions }} {{ a.sessions === 1 ? 'session' : 'sessions' }} · {{ fmtInt(a.tokens) }} tokens</UiButton>
              <span v-if="a.inFlight" class="pill">current browser turn in flight</span>
              <span class="state-last muted" :title="a.lastAt ? fmtStamp(a.lastAt) : ''">
                {{ a.lastAt ? `Last usage ${fmtAgo(a.lastAt, now)}` : 'No recorded usage in this period' }}
              </span>
            </li>
          </ul>
        </UiExpandableRows>
      </div></details>
<details class="secondary-panel" data-testid="limits-block"><summary>Usage budgets <span>{{ limitRows.length }} quotas</span></summary><div class="secondary-body">
        <div class="panel-title">
          <span class="muted">Track token usage against your budgets</span>
          <UiButton data-testid="limit-add" @click="startAddLimit">Add quota</UiButton>
        </div>
        <p v-if="limitRows.length === 0 && !showLimitForm" class="empty">
          No quotas yet. Add one to track spend against a target.
        </p>
        <UiExpandableRows v-else :rows="limitRows" controls-id="dashboard-limits" toggle-test-id="toggle-limits" :ordered-by-rank="false" v-slot="{ rows: visibleRows }">
          <ul id="dashboard-limits" class="limit-list">
            <li
              v-for="row in visibleRows"
              :key="row.limit.id"
              class="limit-row"
              :class="{ warn: row.warn }"
              :data-testid="`limit-row-${row.limit.id}`"
              :data-warn="row.warn ? 'true' : 'false'"
            >
              <div class="limit-head">
                <span class="limit-label">{{ row.limit.label }}</span>
                <span class="mono muted">{{ row.limit.scope }}{{ row.limit.scope !== 'global' ? `:${row.limit.target}` : '' }} · {{ periodLabel(row.limit.period) }}</span>
                <span class="mono" :class="{ 'warn-text': row.warn }" :data-testid="`limit-pct-${row.limit.id}`">
                  {{ fmtInt(row.used) }} / {{ fmtInt(row.limit.targetTokens) }} · {{ row.pct.toFixed(0) }}%
                </span>
                <UiButton size="xs" :aria-label="`Edit ${row.limit.label}`" @click="startEditLimit(row.limit)">Edit</UiButton>
                <UiButton size="xs" variant="danger" :aria-label="`Delete ${row.limit.label}`" @click="deleteLimit(row.limit.id)">Delete</UiButton>
              </div>
              <div
                class="bar limit-bar"
                role="progressbar"
                :aria-valuenow="Math.min(100, Math.round(row.pct))"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="`${row.limit.label}: ${row.pct.toFixed(0)} percent of quota`"
              >
                <span class="fill" :class="{ over: row.warn }" :style="{ width: Math.min(100, row.pct).toFixed(1) + '%' }"></span>
              </div>
            </li>
          </ul>
        </UiExpandableRows>
        <form v-if="showLimitForm" class="limit-form" data-testid="limit-form" @submit.prevent="saveLimit">
          <label>Label <input class="ui-input" v-model="limitForm.label" required maxlength="60" placeholder="e.g. Weekly budget" /></label>
          <label>Scope
            <select class="ui-input" v-model="limitForm.scope">
              <option value="global">global</option>
              <option value="agent">agent</option>
              <option value="project">project</option>
            </select>
          </label>
          <label v-if="limitForm.scope !== 'global'">Target
            <input class="ui-input" v-model="limitForm.target" maxlength="80" placeholder="agent or project name" />
          </label>
          <label>Period
            <select class="ui-input" v-model="limitForm.period">
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          </label>
          <label>Target tokens <input class="ui-input" v-model.number="limitForm.targetTokens" type="number" min="1" step="1" required /></label>
          <div class="form-actions">
            <UiButton type="submit" variant="primary" data-testid="limit-save">Save budget</UiButton>
            <UiButton @click="showLimitForm = false">Cancel</UiButton>
          </div>
        </form>
      </div></details>
            </div>
            <footer class="dashboard-footer">Exports use the full time range, regardless of search or chart selection.</footer>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-scope, .session-detail { padding: 1rem; margin-bottom: 1rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-assistant); overflow-wrap: anywhere; }
.session-scope { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; }
.session-scope p, .session-detail p, .session-detail li { font-size: .75rem; margin: .5rem 0; }
.session-detail dl { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 3fr); gap: .5rem 1rem; font-size: .75rem; }
.session-detail dt { color: var(--text-muted); }
.session-detail dd { margin: 0; }
.session-scope:focus-visible, .session-detail:focus-visible { outline: 2px solid var(--text-accent); }

.view-pane { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.pane-body { flex: 1; min-height: 0; overflow: auto; padding: 2rem 2.125rem 3rem; }
.dashboard-content { max-width: 1480px; margin: 0 auto; }
.dashboard-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.25rem; margin-bottom: 1.5rem; }
.breadcrumb { font-size: .75rem; color: var(--text-muted); margin-bottom: .5rem; }
.dashboard-header h2 { margin: 0; font-size: 1.875rem; font-weight: 650; letter-spacing: -.045rem; line-height: 1.25; }
.subtitle { margin: .5rem 0 0; color: var(--text-secondary); font-size: .875rem; }
.period-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
.range-seg { display: flex; gap: .1875rem; padding: .25rem; background: var(--bg-assistant); border: 1px solid var(--border-color); border-radius: var(--radius-lg); }
.period-label { font-size: .75rem; color: var(--text-muted); }
.analysis-shell { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 1.625rem; }
.analysis-menu { padding-top: .625rem; }
.menu-label { display: block; margin: .5rem .75rem .75rem; font-size: .6875rem; text-transform: uppercase; color: var(--text-muted); }
.breakdown-tabs { display: flex; flex-direction: column; gap: .3125rem; }
.breakdown-tab { width: 100%; justify-content: space-between; text-align: left; }
.tab-count { font-size: .625rem; font-weight: 400; }
.menu-note { padding: 1.25rem .75rem 0; margin: 1.625rem 0 0; border-top: 1px solid var(--border-color); font-size: .6875rem; color: var(--text-muted); line-height: 1.75; }
.analysis-main { min-width: 0; }
.time-layout { display: grid; grid-template-columns: minmax(0,1fr) 238px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-assistant); overflow: hidden; }
.chart-panel { min-width: 0; padding: 1.5rem; display: flex; flex-direction: column; }
.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.25rem; margin-bottom: 1.25rem; }
.panel-heading h3 { margin: 0; font-size: 1.0625rem; font-weight: 600; letter-spacing: -.015rem; }
.panel-heading p { font-size: .75rem; margin: .1875rem 0 0; color: var(--text-muted); }
.chart-unit { font-size: .625rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); padding-top: .25rem; }
.chart { width: 100%; height: auto; display: block; margin: auto 0; }
.chart .grid { stroke: var(--border-faint); stroke-width: 1; }
.chart .axis { fill: var(--text-muted); font-size: 9px; font-family: var(--font-ui); }
.bar-rect { fill: var(--text-accent); }
.bar-est { opacity: .45; }
.bar-hit { fill: transparent; }
.chart-bucket { cursor: pointer; }
.chart-bucket.selected .bar-hit { fill: var(--accent-soft); }
.chart-bucket.selected .bar-rect, .chart-bucket:hover .bar-rect { fill: var(--text-primary); }
.chart-bucket:focus-visible { outline: 2px solid var(--text-accent); outline-offset: 2px; }
.chart-empty { min-height: 208px; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; color: var(--text-secondary); font-size: .8125rem; text-align: center; }
.chart-empty span { max-width: 320px; color: var(--text-muted); font-size: .75rem; }
.chart-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: .875rem; flex-wrap: wrap; }
.chart-footer p { margin: 0; font-size: .6875rem; color: var(--text-muted); }
.chart-footer strong { font-weight: 500; color: var(--text-secondary); }
.chart-zone { display: block; margin-top: .25rem; font-size: .625rem; }
.inspect-select { max-width: 100%; }
.inspect-select select { max-width: 100%; width: 165px; font-size: .6875rem; }
.inspector { padding: 1.5rem 1.3125rem; background: var(--tint-hover); border-left: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 1.25rem; }
.inspector h4 { margin: 0; font-size: .8125rem; font-weight: 600; }
.inspector-dates { margin: .125rem 0 0; font-size: .6875rem; color: var(--text-secondary); }
.inspector-metrics { margin: 0; display: flex; flex-direction: column; gap: 1.1875rem; }
.inspector-metrics dt { color: var(--text-muted); font-size: .6875rem; }
.inspector-metrics dd { margin: 0; }
.inspector-metrics .metric-value { font-size: 1.8125rem; font-weight: 600; letter-spacing: -.025rem; line-height: 1.3; margin-top: .3125rem; overflow-wrap: anywhere; }
.inspector-metrics .metric-money { font-size: 1.5625rem; }
.inspector-metrics .metric-exact { margin-top: .25rem; font-size: .625rem; overflow-wrap: anywhere; }
.inspector-metrics .metric-caption { font-size: .625rem; color: var(--text-muted); margin-top: .125rem; }
.coverage-strip { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin: 1.25rem 0; font-size: .6875rem; color: var(--text-muted); }
.coverage-copy { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding-top: .125rem; }
.coverage-dot { width: 6px; height: 6px; background: var(--bg-success); border-radius: 50%; }
.coverage-tag { border: 1px solid var(--border-color); border-radius: 20px; padding: .0625rem .4375rem; font-size: .625rem; }
.coverage-details { max-width: 460px; }
.coverage-details summary { cursor: pointer; text-align: right; min-height: 28px; }
.coverage-body { padding: 1rem; background: var(--bg-sidebar); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-top: .5rem; }
.coverage-body p { margin: 0 0 .75rem; max-width: 65ch; }
.coverage-body p:last-child { margin-bottom: 0; }
.coverage-body ul { list-style: none; padding: 0; margin: 0 0 .75rem; display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
.panel { background: var(--bg-assistant); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1.5rem; min-width: 0; }
.search-field { display: block; width: 260px; max-width: 100%; margin-bottom: .5rem; }
.search-field input { width: 100%; font-size: .75rem; }
.empty { margin: 1.5rem 0; padding: 1.5rem 0; font-size: .8125rem; color: var(--text-secondary); text-align: center; }
.secondary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.125rem; margin-top: 1.5rem; }
.secondary-panel { border: 1px solid var(--border-color); background: var(--bg-assistant); border-radius: var(--radius-md); min-width: 0; }
.secondary-panel > summary { padding: 1rem 1.25rem; cursor: pointer; font-size: .8125rem; font-weight: 500; }
.secondary-panel > summary span { float: right; color: var(--text-muted); font-weight: 400; font-size: .6875rem; }
.secondary-body { padding: 0 1.25rem 1rem; }
.panel-title { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .75rem; margin-bottom: .75rem; }
.panel-title > :last-child { margin-left: auto; }
.state-list, .limit-list { list-style: none; padding: 0; margin: 0; }
.state-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .5rem 0; border-bottom: 1px solid var(--border-faint); font-size: .6875rem; }
.state-row:last-child, .limit-row:last-child { border: 0; }
.state-name { font-weight: 600; }
.state-cur, .state-last { min-width: 0; overflow-wrap: anywhere; }
.state-last { flex-basis: 100%; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.dot.ok { background: var(--bg-success); }
.pill { color: var(--text-accent); font-size: .625rem; }
.limit-row { padding: .75rem 0; border-bottom: 1px solid var(--border-faint); }
.limit-head { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-bottom: .5rem; font-size: .6875rem; }
.limit-label { font-weight: 600; }
.warn-text, .limit-row.warn .limit-label { color: var(--bg-danger); }
.limit-bar { height: 6px; background: var(--border-faint); border-radius: 3px; overflow: hidden; }
.limit-bar .fill { display: block; height: 100%; background: var(--text-accent); }
.limit-bar .fill.over { background: var(--bg-danger); }
.limit-form { display: flex; flex-direction: column; gap: .75rem; margin-top: 1rem; }
.limit-form label { display: flex; flex-direction: column; gap: .25rem; font-size: .6875rem; color: var(--text-secondary); }
.form-actions { display: flex; gap: .5rem; }
.muted { color: var(--text-muted); }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dashboard-footer { margin-top: 1.5rem; font-size: .6875rem; color: var(--text-muted); }
.export-menu { position: relative; flex-shrink: 0; }
.export-menu > summary { padding: .5rem .75rem; border: 1px solid var(--border-color); border-radius: var(--radius-md); cursor: pointer; list-style: none; font-size: .75rem; }
.export-menu > summary::-webkit-details-marker { display: none; }
.export-menu > summary span { margin-left: .5rem; }
.export-options { position: absolute; top: calc(100% + .5rem); right: 0; z-index: 5; padding: .75rem; display: flex; flex-direction: column; gap: .5rem; width: 210px; background: var(--bg-sidebar); border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.export-options p { margin: .25rem 0 0; font-size: .625rem; color: var(--text-muted); }
.notice { margin: 0 0 1rem; padding: .75rem 1rem; background: var(--tint-hover); border: 1px solid var(--border-color); border-radius: var(--radius-md); font-size: .75rem; color: var(--text-secondary); display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.notice-error { border-color: var(--bg-danger); color: var(--text-primary); }
summary:focus-visible, .explore-panel:focus-visible { outline: 2px solid var(--text-accent); outline-offset: 3px; }
summary:hover { color: var(--text-accent); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
@media (max-width: 1200px) { .pane-body { padding: 1.75rem; } .analysis-shell { grid-template-columns: 140px minmax(0,1fr); gap: 1.125rem; } .time-layout { grid-template-columns: minmax(0,1fr) 205px; } .inspector { padding: 1.25rem 1rem; } .chart-panel, .panel { padding: 1.25rem; } }
@media (max-width: 1000px) { .analysis-shell { display: block; } .analysis-menu { padding-top: 0; margin-bottom: 1rem; } .menu-label, .menu-note { display: none; } .breakdown-tabs { flex-direction: row; gap: .25rem; overflow-x: auto; padding: .25rem; } .breakdown-tab { width: auto; flex-shrink: 0; gap: .5rem; } .time-layout { grid-template-columns: minmax(0,1fr) 220px; } }
@media (max-width: 600px) {
  .pane-body { padding: 1.5rem 1rem 2rem; }
  .dashboard-header { flex-wrap: wrap; margin-bottom: 1.25rem; gap: 1rem; }
  .dashboard-header h2 { font-size: 1.625rem; }
  .breadcrumb { font-size: .6875rem; }
  .subtitle { font-size: .75rem; max-width: 280px; }
  .export-menu > summary { min-height: 44px; display: flex; align-items: center; font-size: .6875rem; }
  .export-options { left: 0; right: auto; }
  .period-toolbar { flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  .range-seg { width: 100%; }
  .range-choice { flex: 1; }
  .period-label { font-size: .625rem; }
  .breakdown-tab { gap: .25rem; }
  .tab-count { font-size: .625rem; }
  .time-layout { display: flex; flex-direction: column; }
  .chart-panel, .panel { padding: 1.125rem 1rem; }
  .panel-heading { gap: .5rem; margin-bottom: 1rem; }
  .panel-heading h3 { font-size: .9375rem; }
  .panel-heading p { font-size: .6875rem; }
  .chart-unit { font-size: .5625rem; }
  .chart-empty { min-height: 170px; }
  .chart-footer { gap: .75rem; margin-top: .75rem; }
  .chart-footer p { font-size: .625rem; }
  .inspect-select { width: 100%; }
  .inspect-select select { width: 100%; min-height: 44px; }
  .inspector { padding: 1rem; border-left: 0; border-top: 1px solid var(--border-color); gap: 1rem; }
  .inspector-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .inspector-metrics > :first-child { grid-column: 1 / -1; }
  .inspector-metrics .metric-value { font-size: 1.5625rem; }
  .inspector-metrics .metric-money { font-size: 1.25rem; }
  .coverage-strip { display: block; margin: 1rem 0; }
  .coverage-details { margin-top: .5rem; }
  .coverage-details summary { text-align: left; min-height: 36px; padding-top: .5rem; }
  .coverage-body { padding: .75rem; }
  .search-field { width: 100%; }
  .search-field input { min-height: 44px; }
  .secondary-grid { grid-template-columns: 1fr; gap: .625rem; margin-top: 1rem; }
  .secondary-panel > summary { min-height: 44px; padding: .875rem 1rem; font-size: .75rem; }
  .secondary-body { padding: 0 1rem 1rem; }
  .dashboard-footer { font-size: .625rem; }
}
</style>
