<script setup lang="ts">
// Dashboard (F5): usage stats + quotas from the activity ledger, agent state (F6).
// All numbers come from useActivityStore; every figure names its range.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useActivityStore, projectName, type UsageSample } from '../stores/activity';
import { useSessionStore } from '../stores/session';
import { useConfigStore } from '../stores/config';
import { useLimitsStore, periodStart, periodLabel, type UsageLimit } from '../stores/limits';
import { useUiStore } from '../stores/ui';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import {
  RANGES,
  rangeBounds,
  rangeLabel,
  type RangeId,
} from '../features/dashboard/range';
import {
  fmtInt,
  fmtCompact,
  fmtCostGroups,
  fmtTokensWithEst,
  groupCost,
  shortDate,
  fmtStamp,
  fmtAgo,
} from '../features/dashboard/format';
import {
  exportFileName,
  toJson,
  toCsv,
  downloadFile,
  type ExportPayload,
} from '../features/dashboard/exportData';

const activity = useActivityStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const limitsStore = useLimitsStore();
const uiStore = useUiStore();

const now = ref(Date.now());
const range = ref<RangeId>('7d');
const rangeLoading = ref(false);
let prefs: KVStore | null = null;

const bounds = computed(() => rangeBounds(range.value, now.value));
const windowLabel = computed(() => rangeLabel(range.value, bounds.value.from, bounds.value.to));

const summary = computed(() => {
  const { from, to } = bounds.value;
  const u = activity.totalUsage(from, to);
  const rows = activity.usageInRange(from, to);
  const sessions = new Set(rows.map((r) => r.sessionId)).size;
  const toolCalls = activity
    .entriesInRange(from, to)
    .filter((e) => e.kind === 'tool-call').length;
  return { ...u, sessions, toolCalls, costs: groupCost(rows) };
});

interface AgentRow {
  name: string;
  tokens: number;
  estTokens: number;
  cost: number;
  turns: number;
  share: number;
  lastAt: number;
  lastText: string;
  costs: string;
}

const agentRows = computed<AgentRow[]>(() => {
  const { from, to } = bounds.value;
  const rows = activity.usageByAgent(from, to);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  const samples = activity.usageInRange(from, to);
  const entries = activity.entriesInRange(from, to);
  return rows.map((r) => {
    const last = [...entries].reverse().find((e) => e.agentName === r.agentName);
    return {
      name: r.agentName,
      tokens: r.tokens,
      estTokens: r.estTokens,
      cost: r.cost,
      turns: r.turns,
      share: total > 0 ? (r.tokens / total) * 100 : 0,
      lastAt: last?.at ?? 0,
      lastText: last?.title ?? last?.detail ?? last?.kind ?? '—',
      costs: fmtCostGroups(
        groupCost(samples.filter((s) => s.agentName === r.agentName))
      ),
    };
  });
});

interface ProjectRow {
  project: string;
  cwd: string;
  tokens: number;
  estTokens: number;
  cost: number;
  turns: number;
  share: number;
  lastAt: number;
  costs: string;
}

const projectRows = computed<ProjectRow[]>(() => {
  const { from, to } = bounds.value;
  const rows = activity.usageByProject(from, to);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  const samples = activity.usageInRange(from, to);
  const entries = activity.entriesInRange(from, to);
  return rows.map((r) => {
    const lastAt =
      [...samples].reverse().find((s) => projectName(s.cwd) === r.project)?.at ??
      [...entries].reverse().find((e) => projectName(e.cwd) === r.project)?.at ??
      0;
    const cur = samples.find((s) => projectName(s.cwd) === r.project)?.cwd ?? r.cwd ?? '';
    return {
      project: r.project,
      cwd: cur || r.cwd || '',
      tokens: r.tokens,
      estTokens: r.estTokens,
      cost: r.cost,
      turns: r.turns,
      share: total > 0 ? (r.tokens / total) * 100 : 0,
      lastAt,
      costs: fmtCostGroups(groupCost(samples.filter((s) => projectName(s.cwd) === r.project))),
    };
  });
});

interface ModelRow {
  model: string;
  provider: string;
  tokens: number;
  estTokens: number;
  cost: number;
  turns: number;
  share: number;
  lastAt: number;
  costs: string;
}

const modelRows = computed<ModelRow[]>(() => {
  const { from, to } = bounds.value;
  const rows = activity.usageByModel(from, to);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  const samples = activity.usageInRange(from, to);
  return rows.map((r) => {
    const mine = samples.filter((s) => (s.model ?? 'unknown') === r.model);
    return {
      model: r.model,
      provider: r.provider,
      tokens: r.tokens,
      estTokens: r.estTokens,
      cost: r.cost,
      turns: r.turns,
      share: total > 0 ? (r.tokens / total) * 100 : 0,
      lastAt: mine.length ? mine[mine.length - 1].at : 0,
      costs: fmtCostGroups(groupCost(mine)),
    };
  });
});

interface DayPoint {
  day: string;
  label: string;
  tokens: number;
  estTokens: number;
  cost: number;
  turns: number;
  costs: string;
}

/**
 * Axis/table label for one bucket. A bucket is one day, or a week when the span is
 * long (the step above 120 days) — and a week that prints as its first day reads
 * like a day, which is exactly the confusion reported ("таблица на все дни года").
 */
function labelFor(key: string, startMs: number, step: number): string {
  if (step === 1) return shortDate(key);
  const end = new Date(startMs + 6 * 86400000).toISOString().slice(0, 10);
  return `${shortDate(key)} – ${shortDate(end)}`;
}

const dayPoints = computed<DayPoint[]>(() => {
  const { from, to } = bounds.value;
  const rows = activity.usageByDay(from, to);
  const samples = activity.usageInRange(from, to);
  // Fill gaps so the chart axis holds with sparse data; week buckets for long ranges.
  const filled = new Map(rows.map((r) => [r.day, r]));
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const step = spanDays > 120 ? 7 : 1;
  const out: DayPoint[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += step * 86400000) {
    let tokens = 0;
    let estTokens = 0;
    let cost = 0;
    let turns = 0;
    let key = '';
    if (step === 1) {
      key = iso(new Date(t));
      const r = filled.get(key);
      if (r) {
        tokens = r.tokens;
        estTokens = r.estTokens;
        cost = r.cost;
        turns = r.turns;
      }
    } else {
      key = iso(new Date(t));
      for (let k = 0; k < 7; k++) {
        const r = filled.get(iso(new Date(t + k * 86400000)));
        if (r) {
          tokens += r.tokens;
          estTokens += r.estTokens;
          cost += r.cost;
          turns += r.turns;
        }
      }
    }
    out.push({ day: key, label: labelFor(key, t, step), tokens, estTokens, cost, turns, costs: fmtCostGroups(
        groupCost(
          samples.filter((s) => {
            const sd = new Date(s.at).toISOString().slice(0, 10);
            if (step === 1) return sd === key;
            return sd >= key && sd <= iso(new Date(t + 6 * 86400000));
          })
        )
      ),
    });
  }
  return out;
});

/**
 * Table and CSV list days WITH data. The chart keeps the gap-filled series so
 * its axis stays continuous, but printing a few hundred empty rows (a year-long
 * range fills every bucket) is noise, not information.
 */
const tableRows = computed(() =>
  dayPoints.value.filter((d) => d.tokens > 0 || d.cost > 0 || d.turns > 0)
);

const maxDayTokens = computed(() =>
  dayPoints.value.reduce((m, d) => Math.max(m, d.tokens), 0)
);

// --- SVG bar chart geometry (hand-rolled, no chart lib) ---
const CHART_W = 640;
const CHART_H = 148;
const PAD_L = 44;
const PAD_B = 22;
const PAD_T = 8;

function yTicks(): number[] {
  const max = maxDayTokens.value;
  if (max <= 0) return [0];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [0];
  for (let v = step; v <= max * 1.05; v += step) ticks.push(v);
  return ticks;
}

const chartGeom = computed(() => {
  const n = dayPoints.value.length;
  const max = Math.max(maxDayTokens.value, 1);
  const plotW = CHART_W - PAD_L - 8;
  const plotH = CHART_H - PAD_T - PAD_B;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(2, Math.min(28, slot * 0.6));
  return dayPoints.value.map((d, i) => {
    const h = (d.tokens / max) * plotH;
    // The estimate share stacks on top and renders hatched, so a day's bar
    // never presents a bridge guess as agent-measured tokens.
    const hTotal = Math.max(d.tokens > 0 ? 2 : 0, h);
    const hEst = Math.min((Math.min(d.estTokens, d.tokens) / max) * plotH, hTotal);
    const hFact = hTotal - hEst;
    return {
      x: PAD_L + slot * i + (slot - barW) / 2,
      y: PAD_T + plotH - hTotal,
      w: barW,
      h: hTotal,
      yFact: PAD_T + plotH - hFact,
      hFact,
      yEst: PAD_T + plotH - hFact - hEst,
      hEst,
    };
  });
});

const yFor = (v: number): number => {
  const max = Math.max(maxDayTokens.value, 1);
  const plotH = CHART_H - PAD_T - PAD_B;
  return PAD_T + plotH - (v / max) * plotH;
};

// --- Sessions top-N ---
interface SessionRow {
  key: string;
  title: string;
  agentName: string;
  project: string;
  tokens: number;
  estTokens: number;
  cost: number;
  lastAt: number;
  sessionId: string;
  costs: string;
}

const sessionRows = computed<SessionRow[]>(() => {
  const { from, to } = bounds.value;
  // deltaRows: what each session consumed in the window (last minus baseline),
  // not the sum of its running totals — summing `used` across samples
  // multiplied a session by its sample count, the same xN bug the summary had.
  const deltas = activity.deltaRows(from, to);
  const samples = activity.usageInRange(from, to);
  const lastSampleAt = new Map<string, number>();
  const samplesBySession = new Map<string, UsageSample[]>();
  for (const s of samples) {
    lastSampleAt.set(s.sessionId, Math.max(lastSampleAt.get(s.sessionId) ?? 0, s.at));
    const list = samplesBySession.get(s.sessionId) ?? [];
    list.push(s);
    samplesBySession.set(s.sessionId, list);
  }
  const meta = new Map<string, { title: string; agentName: string; cwd?: string; at: number }>();
  for (const e of activity.entriesInRange(from, to)) {
    if (!e.sessionId) continue;
    const m = meta.get(e.sessionId);
    if (!m || e.at > m.at) {
      meta.set(e.sessionId, {
        title: e.title ?? m?.title ?? e.sessionId.slice(0, 8),
        agentName: e.agentName,
        cwd: e.cwd ?? m?.cwd,
        at: e.at,
      });
    }
  }
  return deltas
    .map((row) => {
      const sessionId = row.sessionId ?? '';
      const m = meta.get(sessionId);
      const sessionSamples = samplesBySession.get(sessionId) ?? [];
      return {
        key: sessionId,
        title: m?.title ?? sessionId.slice(0, 8),
        agentName: m?.agentName ?? row.agentName,
        project: projectName(m?.cwd ?? row.cwd),
        tokens: row.tokens,
        estTokens: row.source === 'estimate' ? row.tokens : 0,
        cost: row.cost,
        lastAt: Math.max(m?.at ?? 0, lastSampleAt.get(sessionId) ?? 0),
        sessionId,
        costs: fmtCostGroups(groupCost(sessionSamples)),
      };
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);
});

async function openSession(row: SessionRow): Promise<void> {
  const saved = sessionStore.savedSessions.find((s) => s.sessionId === row.sessionId);
  if (!saved) return;
  try {
    await sessionStore.resumeSession(saved);
    await uiStore.setView('chat');
  } catch (e) {
    console.warn('Resume from dashboard failed:', e);
  }
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
  return {
    exportedAt: new Date(now.value).toISOString(),
    range: range.value,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    summary: {
      tokens: summary.value.tokens,
      cost: summary.value.cost,
      turns: summary.value.turns,
      sessions: summary.value.sessions,
      toolCalls: summary.value.toolCalls,
    },
    byAgent: agentRows.value.map((r) => ({
      agentName: r.name,
      tokens: r.tokens,
      cost: r.cost,
      turns: r.turns,
    })),
    byDay: tableRows.value.map((d) => ({ day: d.day, tokens: d.tokens, cost: d.cost, turns: d.turns })),
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

// --- Agent state strip (F6) ---
interface AgentState {
  name: string;
  transport: string;
  reachable: boolean;
  currentSession: string;
  inFlight: boolean;
  lastAt: number;
  lastText: string;
}

const agentStates = computed<AgentState[]>(() => {
  const names = configStore.allAgentNames;
  const entries = activity.entries;
  return names.map((name) => {
    const cfg = configStore.getAgent(name);
    const transport = cfg?.transport ?? 'stdio';
    const last = [...entries].reverse().find((e) => e.agentName === name);
    const isCurrent = sessionStore.currentSession?.agentName === name;
    return {
      name,
      transport,
      reachable: transport !== 'stdio',
      currentSession: isCurrent ? (sessionStore.currentSession?.title ?? '—') : '—',
      inFlight: isCurrent && sessionStore.isLoading,
      lastAt: last?.at ?? 0,
      lastText: last ? `${last.kind}${last.title ? ` · ${last.title}` : ''}` : 'no events yet',
    };
  });
});

async function setRange(id: RangeId): Promise<void> {
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
});

onMounted(async () => {
  prefs = await loadKvStore('preferences.json');
  const saved = await prefs.get<RangeId>('dashboardRange');
  if (saved && RANGES.some((r) => r.id === saved)) range.value = saved;
  await limitsStore.initLimitsStore();
  tickTimer = setInterval(() => {
    now.value = Date.now();
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
    <header class="pane-head">
      <h2>Dashboard</h2>
      <div
        class="range-seg"
        role="group"
        aria-label="Time range"
        data-testid="range-selector"
      >
        <button
          v-for="r in RANGES"
          :key="r.id"
          class="seg-btn"
          :class="{ active: range === r.id }"
          :aria-pressed="range === r.id"
          :data-testid="`range-${r.id}`"
          @click="setRange(r.id)"
        >
          {{ r.label }}
        </button>
      </div>
    </header>
    <div class="pane-sub">
      <span class="pane-note" data-testid="range-label">{{ windowLabel }}</span>
      <span class="sr-live" aria-live="polite">{{ rangeLoading ? 'Loading range…' : '' }}</span>
    </div>

    <div class="pane-body">
      <!-- Summary strip: one dense line per metric -->
      <section class="panel" aria-label="Summary" data-testid="summary-strip">
        <div class="panel-title">Summary <span class="muted">· {{ windowLabel }}</span></div>
        <dl class="summary">
          <div class="sum-row"><dt>Tokens used</dt><dd data-testid="sum-tokens" :data-est="summary.estTokens > 0">{{ fmtTokensWithEst(summary.tokens, summary.estTokens) }}</dd></div>
          <div class="sum-row"><dt>Cost</dt><dd data-testid="sum-cost">{{ fmtCostGroups(summary.costs) }}</dd></div>
          <div class="sum-row"><dt>Turns</dt><dd data-testid="sum-turns">{{ fmtInt(summary.turns) }}</dd></div>
          <div class="sum-row"><dt>Sessions touched</dt><dd data-testid="sum-sessions">{{ fmtInt(summary.sessions) }}</dd></div>
          <div class="sum-row"><dt>Tool calls</dt><dd data-testid="sum-tools">{{ fmtInt(summary.toolCalls) }}</dd></div>
        </dl>
        <p class="legend muted" data-testid="usage-legend">
          plain = reported by the agent · <span class="est-mark">~</span> = bridge
          estimate (chars ÷ 4) for agents that don't report usage
        </p>
      </section>

      <!-- Agent state strip (F6) -->
      <section class="panel" aria-label="Agent state" data-testid="agent-state">
        <div class="panel-title">Agents <span class="muted">· live state</span></div>
        <p v-if="agentStates.length === 0" class="empty">No agents configured.</p>
        <ul v-else class="state-list">
          <li v-for="a in agentStates" :key="a.name" class="state-row">
            <span class="dot" :class="{ ok: a.reachable, bad: !a.reachable }" aria-hidden="true"></span>
            <span class="state-name">{{ a.name }}</span>
            <span class="mono muted">{{ a.transport }}</span>
            <span class="state-cur" :title="a.currentSession">session: {{ a.currentSession }}</span>
            <span v-if="a.inFlight" class="pill">turn in flight</span>
            <span class="state-last muted" :title="a.lastAt ? fmtStamp(a.lastAt) : ''">
              {{ a.lastAt ? `${fmtAgo(a.lastAt, now)} · ${a.lastText}` : a.lastText }}
            </span>
          </li>
        </ul>
      </section>

      <div class="cols">
        <!-- By agent -->
        <section class="panel" aria-label="Usage by agent">
          <div class="panel-title">By agent <span class="muted">· {{ windowLabel }}</span></div>
          <p v-if="agentRows.length === 0" class="empty" data-testid="agents-empty">
            no usage recorded yet<br />
            <span class="muted">Numbers come from the agents' usage_update notifications and the bridges' estimates.</span>
          </p>
          <table v-else class="dense" data-testid="by-agent-table">
            <thead>
              <tr><th scope="col">Agent</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Turns</th><th scope="col">Share</th><th scope="col">Last activity</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in agentRows" :key="r.name" data-testid="by-agent-row" :data-agent="r.name" :data-tokens="r.tokens" :data-est="r.estTokens > 0">
                <td data-label="Agent">{{ r.name }}</td>
                <td class="num mono" data-label="Tokens" :title="r.estTokens > 0 ? `${fmtInt(r.estTokens)} of these are a bridge estimate` : ''">{{ fmtTokensWithEst(r.tokens, r.estTokens) }}</td>
                <td class="num mono" data-label="Cost">{{ r.costs }}</td>
                <td class="num mono" data-label="Turns">{{ fmtInt(r.turns) }}</td>
                <td class="share-cell" data-label="Share">
                  <span class="bar" aria-hidden="true"><span class="fill" :style="{ width: r.share.toFixed(1) + '%' }"></span></span>
                  <span class="mono muted">{{ r.share.toFixed(0) }}%</span>
                </td>
                <td class="muted" data-label="Last activity" :title="r.lastAt ? fmtStamp(r.lastAt) : ''">{{ r.lastAt ? fmtAgo(r.lastAt, now) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- By project -->
        <section class="panel" aria-label="Usage by project">
          <div class="panel-title">By project <span class="muted">· {{ windowLabel }}</span></div>
          <p v-if="projectRows.length === 0" class="empty">
            no usage recorded yet<br />
            <span class="muted">Numbers come from the agents' usage_update notifications and the bridges' estimates.</span>
          </p>
          <table v-else class="dense" data-testid="by-project-table">
            <thead>
              <tr><th scope="col">Project</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Turns</th><th scope="col">Share</th><th scope="col">Last activity</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in projectRows" :key="r.project" :title="r.cwd" :data-est="r.estTokens > 0">
                <td data-label="Project"><span :title="r.cwd" class="mono">{{ r.project }}</span></td>
                <td class="num mono" data-label="Tokens" :title="r.estTokens > 0 ? `${fmtInt(r.estTokens)} of these are a bridge estimate` : ''">{{ fmtTokensWithEst(r.tokens, r.estTokens) }}</td>
                <td class="num mono" data-label="Cost">{{ r.costs }}</td>
                <td class="num mono" data-label="Turns">{{ fmtInt(r.turns) }}</td>
                <td class="share-cell" data-label="Share">
                  <span class="bar" aria-hidden="true"><span class="fill" :style="{ width: r.share.toFixed(1) + '%' }"></span></span>
                  <span class="mono muted">{{ r.share.toFixed(0) }}%</span>
                </td>
                <td class="muted" data-label="Last activity" :title="r.lastAt ? fmtStamp(r.lastAt) : ''">{{ r.lastAt ? fmtAgo(r.lastAt, now) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- By model -->
        <section class="panel" aria-label="Usage by model">
          <div class="panel-title">By model <span class="muted">· {{ windowLabel }}</span></div>
          <p v-if="modelRows.length === 0" class="empty" data-testid="models-empty">
            no usage recorded yet<br />
            <span class="muted">The model comes from the session's announced model id; rows written before that field existed read as unknown.</span>
          </p>
          <table v-else class="dense" data-testid="by-model-table">
            <thead>
              <tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Turns</th><th scope="col">Share</th><th scope="col">Last activity</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in modelRows" :key="r.model" data-testid="by-model-row" :data-model="r.model" :data-est="r.estTokens > 0">
                <td data-label="Model"><span class="mono">{{ r.model }}</span></td>
                <td class="muted" data-label="Provider">{{ r.provider }}</td>
                <td class="num mono" data-label="Tokens" :title="r.estTokens > 0 ? `${fmtInt(r.estTokens)} of these are a bridge estimate` : ''">{{ fmtTokensWithEst(r.tokens, r.estTokens) }}</td>
                <td class="num mono" data-label="Cost">{{ r.costs }}</td>
                <td class="num mono" data-label="Turns">{{ fmtInt(r.turns) }}</td>
                <td class="share-cell" data-label="Share">
                  <span class="bar" aria-hidden="true"><span class="fill" :style="{ width: r.share.toFixed(1) + '%' }"></span></span>
                  <span class="mono muted">{{ r.share.toFixed(0) }}%</span>
                </td>
                <td class="muted" data-label="Last activity" :title="r.lastAt ? fmtStamp(r.lastAt) : ''">{{ r.lastAt ? fmtAgo(r.lastAt, now) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <!-- By day: chart + table -->
      <section class="panel" aria-label="Usage by day">
        <div class="panel-title">By day <span class="muted">· tokens per day, {{ windowLabel }}</span></div>
        <div v-if="tableRows.length === 0" class="empty" data-testid="day-empty">
          No days in this range.
        </div>
        <div v-else-if="maxDayTokens === 0" class="empty" data-testid="day-empty">
          No usage in this range yet — figures cover {{ windowLabel }}.
        </div>
        <div v-else class="chart-wrap">
          <svg
            :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
            class="chart"
            role="img"
            aria-label="Tokens per day bar chart"
            data-testid="day-chart"
          >
            <g v-for="t in yTicks()" :key="t">
              <line :x1="PAD_L" :x2="CHART_W - 8" :y1="yFor(t)" :y2="yFor(t)" class="grid" />
              <text :x="PAD_L - 6" :y="yFor(t) + 3.5" text-anchor="end" class="axis">{{ fmtCompact(t) }}</text>
            </g>
            <g v-for="(d, i) in dayPoints" :key="d.day">
              <rect
                v-if="chartGeom[i].hEst > 0"
                :x="chartGeom[i].x"
                :y="chartGeom[i].yEst"
                :width="chartGeom[i].w"
                :height="chartGeom[i].hEst"
                class="bar-rect bar-est"
                data-testid="day-bar-est"
                :data-day="d.day"
                :data-tokens="d.estTokens"
              />
              <rect
                :x="chartGeom[i].x"
                :y="chartGeom[i].hEst > 0 ? chartGeom[i].yFact : chartGeom[i].y"
                :width="chartGeom[i].w"
                :height="chartGeom[i].hEst > 0 ? chartGeom[i].hFact : chartGeom[i].h"
                class="bar-rect"
                data-testid="day-bar"
                :data-day="d.day"
                :data-tokens="d.tokens"
              >
                <title>{{ d.label }}: {{ fmtTokensWithEst(d.tokens, d.estTokens) }} tokens, {{ d.turns }} turns</title>
              </rect>
            </g>
            <g v-for="(d, i) in dayPoints" :key="'x' + d.day">
              <text
                v-if="dayPoints.length <= 31 || i % Math.ceil(dayPoints.length / 10) === 0"
                :x="chartGeom[i].x + chartGeom[i].w / 2"
                :y="CHART_H - 6"
                text-anchor="middle"
                class="axis"
              >
                {{ d.label }}
              </text>
            </g>
          </svg>
        </div>
        <table v-if="tableRows.length > 0" class="dense" data-testid="by-day-table">
          <thead>
            <tr><th scope="col">Day / week</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Turns</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in tableRows" :key="d.day" data-testid="by-day-row" :data-day="d.day" :data-est="d.estTokens > 0">
              <td data-label="Day">{{ d.label }}</td>
              <td class="num mono" data-label="Tokens">{{ fmtTokensWithEst(d.tokens, d.estTokens) }}</td>
              <td class="num mono" data-label="Cost">{{ d.costs }}</td>
              <td class="num mono" data-label="Turns">{{ fmtInt(d.turns) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Sessions top-N -->
      <section class="panel" aria-label="Top sessions">
        <div class="panel-title">Top sessions <span class="muted">· by tokens, {{ windowLabel }}</span></div>
        <p v-if="sessionRows.length === 0" class="empty">No sessions with usage in this range.</p>
        <table v-else class="dense" data-testid="top-sessions-table">
          <thead>
            <tr><th scope="col">Session</th><th scope="col">Agent</th><th scope="col">Project</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th><th scope="col">Last turn</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in sessionRows" :key="s.key" :data-est="s.estTokens > 0">
              <td data-label="Session">
                <button class="link" :title="`Open ${s.title} in chat`" @click="openSession(s)">{{ s.title }}</button>
              </td>
              <td data-label="Agent">{{ s.agentName }}</td>
              <td class="mono" data-label="Project">{{ s.project }}</td>
              <td class="num mono" data-label="Tokens" :title="s.estTokens > 0 ? 'bridge estimate' : ''">{{ fmtTokensWithEst(s.tokens, s.estTokens) }}</td>
              <td class="num mono" data-label="Cost">{{ s.costs }}</td>
              <td class="muted mono" data-label="Last turn" :title="fmtStamp(s.lastAt)">{{ fmtAgo(s.lastAt, now) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Limits -->
      <section class="panel" aria-label="Limits" data-testid="limits-block">
        <div class="panel-title">
          Limits <span class="muted">· quotas vs ledger usage</span>
          <button class="mini-btn" data-testid="limit-add" @click="startAddLimit">Add quota</button>
        </div>
        <p v-if="limitRows.length === 0 && !showLimitForm" class="empty">
          No quotas yet. Add one to track spend against a target.
        </p>
        <ul v-else class="limit-list">
          <li
            v-for="row in limitRows"
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
              <button class="mini-btn" :aria-label="`Edit ${row.limit.label}`" @click="startEditLimit(row.limit)">Edit</button>
              <button class="mini-btn danger" :aria-label="`Delete ${row.limit.label}`" @click="deleteLimit(row.limit.id)">Del</button>
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
        <form v-if="showLimitForm" class="limit-form" data-testid="limit-form" @submit.prevent="saveLimit">
          <label>Label <input v-model="limitForm.label" required maxlength="60" placeholder="e.g. Weekly budget" /></label>
          <label>Scope
            <select v-model="limitForm.scope">
              <option value="global">global</option>
              <option value="agent">agent</option>
              <option value="project">project</option>
            </select>
          </label>
          <label v-if="limitForm.scope !== 'global'">Target
            <input v-model="limitForm.target" maxlength="80" placeholder="agent or project name" />
          </label>
          <label>Period
            <select v-model="limitForm.period">
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          </label>
          <label>Target tokens <input v-model.number="limitForm.targetTokens" type="number" min="1" step="1" required /></label>
          <div class="form-actions">
            <button type="submit" class="mini-btn primary" data-testid="limit-save">Save</button>
            <button type="button" class="mini-btn" @click="showLimitForm = false">Cancel</button>
          </div>
        </form>
      </section>

      <!-- Export -->
      <section class="panel" aria-label="Export">
        <div class="panel-title">Export <span class="muted">· range data, {{ windowLabel }}</span></div>
        <div class="export-row">
          <button class="mini-btn" data-testid="export-json" @click="exportJson">Download JSON</button>
          <button class="mini-btn" data-testid="export-csv" @click="exportCsv">Download CSV</button>
          <span class="muted mono file-hint">{{ exportFileName(range, bounds.to, 'json') }}</span>
        </div>
      </section>
    </div>
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
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.pane-head h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.pane-sub {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.375rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.pane-note {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.sr-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

/* Segmented range control */
.range-seg {
  display: flex;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
}

.seg-btn {
  min-height: 30px;
  padding: 0 0.75rem;
  border: none;
  border-right: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.seg-btn:last-child {
  border-right: none;
}

.seg-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.seg-btn.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  color: var(--text-accent, #c2532f);
  font-weight: 600;
}

.seg-btn:focus-visible,
.mini-btn:focus-visible,
.link:focus-visible {
  outline: 2px solid var(--text-accent, #c2532f);
  outline-offset: 1px;
}

.pane-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overflow-x: hidden;
  padding: 0.75rem 1rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.panel {
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  padding: 0.5rem 0.75rem 0.625rem;
  background: transparent;
}

.panel-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
  margin-bottom: 0.375rem;
}

.muted {
  color: var(--text-muted, #a39a8e);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.empty {
  margin: 0.25rem 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-secondary, #6b6259);
}

/* Summary: one dense line per metric */
.summary {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.sum-row {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  min-height: 28px;
  padding: 0.125rem 0;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.sum-row:last-child {
  border-bottom: none;
}

.sum-row dt {
  flex: 0 0 140px;
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
}

.sum-row dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow-wrap: break-word;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 0.75rem;
  color: var(--text-primary, #2b2723);
}

/* Dense tables */
table.dense {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}

table.dense th {
  text-align: left;
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
  padding: 0.25rem 0.5rem 0.25rem 0;
  border-bottom: 1px solid var(--border-color, #e3dbcf);
}

table.dense td {
  padding: 0.25rem 0.5rem 0.25rem 0;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  min-height: 28px;
  vertical-align: middle;
}

table.dense tr:last-child td {
  border-bottom: none;
}

table.dense .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

table.dense th.num {
  text-align: right;
}

.share-cell {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 90px;
}

/* Progress bars: accent fill, hairline track */
.bar {
  flex: 1;
  min-width: 40px;
  height: 6px;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: 3px;
  overflow: hidden;
}

.bar .fill {
  display: block;
  height: 100%;
  background: var(--text-accent, #c2532f);
}

.bar .fill.over {
  background: var(--bg-danger, #b3402e);
}

/* Chart */
.chart-wrap {
  width: 100%;
  overflow: hidden;
}

.chart {
  display: block;
  width: 100%;
  height: auto;
}

.chart .grid {
  stroke: var(--border-faint, rgba(43, 39, 35, 0.09));
  stroke-width: 1;
}

.chart .axis {
  fill: var(--text-muted, #a39a8e);
  font-size: 10px;
  font-family: var(--font-mono, monospace);
}

.chart .bar-rect {
  fill: var(--text-accent, #c2532f);
}

/* The estimate share of a day bar: same hue, diagonal hatch — visible as
 * "not exact" at a glance. */
.chart .bar-est {
  fill: var(--text-accent, #c2532f);
  opacity: 0.45;
}

.legend {
  margin: 0.375rem 0 0;
  font-size: 0.6875rem;
}

.est-mark {
  font-weight: 600;
}

/* State strip */
.state-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.state-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 28px;
  padding: 0.125rem 0;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  font-size: 0.75rem;
}

.state-row:last-child {
  border-bottom: none;
}

.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted, #a39a8e);
}

.dot.ok {
  background: var(--bg-success, #5a7d4f);
}

.dot.bad {
  background: var(--bg-danger, #b3402e);
}

.state-name {
  font-weight: 600;
  white-space: nowrap;
}

.state-cur {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary, #6b6259);
}

.state-last {
  flex: 0 1 auto;
  max-width: 40%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.6875rem;
}

.pill {
  flex: 0 0 auto;
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-accent, #c2532f);
  border: 1px solid var(--text-accent, #c2532f);
  border-radius: 3px;
  padding: 0.0625rem 0.3125rem;
}

/* Limits */
.limit-list {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
}

.limit-row {
  padding: 0.375rem 0;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.limit-row:last-child {
  border-bottom: none;
}

.limit-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  margin-bottom: 0.25rem;
}

.limit-label {
  font-weight: 600;
}

.limit-row.warn .limit-label {
  color: var(--bg-danger, #b3402e);
}

.warn-text {
  color: var(--bg-danger, #b3402e);
  font-weight: 600;
}

.limit-bar {
  height: 8px;
}

.limit-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.limit-form label {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
}

.limit-form input,
.limit-form select {
  min-height: 30px;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
}

.form-actions {
  display: flex;
  align-items: flex-end;
  gap: 0.375rem;
}

.mini-btn {
  min-height: 30px;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  margin-left: auto;
}

.panel-title .mini-btn {
  margin-left: auto;
}

.limit-head .mini-btn,
.export-row .mini-btn {
  margin-left: 0;
}

.mini-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.mini-btn.primary {
  background: var(--bg-primary, #c2532f);
  border-color: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fbf8f3);
}

.mini-btn.danger {
  color: var(--bg-danger, #b3402e);
}

.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--text-accent, #c2532f);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  text-align: left;
}

.link:hover {
  text-decoration: underline;
}

.export-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.file-hint {
  font-size: 0.6875rem;
}

.cols {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}

/* ---------- Responsive (N1) ---------- */
@media (min-width: 1280px) {
  .cols {
    grid-template-columns: 1fr 1fr;
  }

  .cols .panel {
    min-width: 0;
  }
}

@media (max-width: 767px) {
  .pane-head {
    flex-wrap: wrap;
  }

  .range-seg {
    flex: 1 1 100%;
  }

  .seg-btn {
    flex: 1 1 0;
    min-height: 44px;
    padding: 0 0.25rem;
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  .mini-btn {
    min-height: 44px;
    padding: 0.5rem 0.875rem;
  }

  .sum-row dt {
    flex-basis: 110px;
  }

  .sum-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    padding: 0.25rem 0;
  }

  .sum-row dt {
    flex: none;
  }

  .sum-row dd {
    text-align: left;
  }

  /* Tables become stacked labelled rows: no horizontal scrolling. */
  table.dense thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  table.dense,
  table.dense tbody,
  table.dense tr,
  table.dense td {
    display: block;
    width: 100%;
  }

  table.dense tr {
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--border-color, #e3dbcf);
  }

  table.dense tr:last-child {
    border-bottom: none;
  }

  table.dense td {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    border: none;
    padding: 0.125rem 0;
    min-height: 0;
  }

  table.dense td::before {
    content: attr(data-label);
    flex: 0 0 110px;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-muted, #a39a8e);
  }

  table.dense .num {
    text-align: left;
  }

  .share-cell {
    min-width: 0;
  }

  .limit-head {
    flex-wrap: wrap;
  }

  .state-row {
    flex-wrap: wrap;
    min-height: 44px;
  }

  .state-last {
    flex-basis: 100%;
    max-width: 100%;
  }
}
</style>
