<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import type { BoardCard, BoardStageId, CardStatus } from '../../stores/board';
import { useBoardStore } from '../../stores/board';
import { useRolesStore } from '../../stores/roles';
import { useUiStore } from '../../stores/ui';
import { useProjectsStore } from '../../stores/projects';
import { useArtifactsStore, pickStatusArtifact } from '../../stores/artifacts';
import { useReviewStore } from '../../stores/review';
import { useActivityStore } from '../../stores/activity';
import { useClaimsStore } from '../../stores/claims';
import { runInfoFor, subagentsFor, type SubagentRow } from './runInfo';
import { BOARD_STAGES, stageLabel, statusesForStage } from './columns';
import { fmtStamp, fmtDur } from './format';

const props = defineProps<{
  card: BoardCard;
}>();

const emit = defineEmits<{
  open: [card: BoardCard];
  move: [cardId: string, to: BoardStageId, beforeId?: string | null];
  'set-status': [cardId: string, status: CardStatus];
  'set-flag': [cardId: string, flag: 'blocked' | 'cancelled', on: boolean];
  duplicate: [cardId: string];
  remove: [cardId: string];
  reorder: [cardId: string, delta: -1 | 1];
  dragstart: [cardId: string, event: DragEvent];
  dragend: [];
}>();

const board = useBoardStore();
const uiStore = useUiStore();
const rolesStore = useRolesStore();
const projectsStore = useProjectsStore();
const artifactsStore = useArtifactsStore();
const reviewStore = useReviewStore();
const activityStore = useActivityStore();
const claimsStore = useClaimsStore();

const menuOpen = ref(false);
const statusOpen = ref(false);

const otherStages = computed(() => BOARD_STAGES.filter((c) => c.id !== props.card.stage));
const stageStatuses = computed(() => statusesForStage(props.card.stage));

/** All-mode only: a card whose project label resolves to no registry
 * project (or has none) is marked `unassigned`. Scoped views never see it. */
const unassigned = computed(
  () => uiStore.activeProjectId === 'all' && board.projectIdForCard(props.card) === null
);

/** The role bound to the card's stage (roles.json stageRoles). The card
 * model itself stays untouched — the badge is derived at render time. */
const stageRole = computed(() => rolesStore.roleForStage(props.card.stage));
const stageRoleHasRunner = computed(
  () => !!stageRole.value && rolesStore.roleHasRunner(stageRole.value)
);

/** STATUS token badge (W6-A): the token of the stage's latest artifact,
 * read through the bridge by the artifacts store (session-cached; the
 * card asks once on mount when its project resolves to a registry path). */
const statusToken = computed(() => {
  const st = artifactsStore.byCard[props.card.id];
  if (!st || !st.artifacts.length) return null;
  return pickStatusArtifact(props.card.stage, st.artifacts)?.token ?? null;
});

const SEV_SHORT: Record<string, string> = {
  critical: 'crit',
  major: 'maj',
  minor: 'min',
  nit: 'nit',
};

/** Review-cycle counter chip: open findings per severity + the round,
 * from the card's `review_findings.json` (review store). Severity names
 * and the round limit come from the reviewtest role's `review` data. */
const reviewInfo = computed(() => {
  const st = reviewStore.byCard[props.card.id];
  if (!st || st.error) return null;
  if (!st.findings.length && st.round === null) return null;
  const rules = rolesStore.reviewRulesForStage('reviewtest');
  const counts = reviewStore.openCounts(props.card.id);
  const parts = rules.severities.map(
    (s) => `${SEV_SHORT[s] ?? s.slice(0, 4)} ${counts[s] ?? 0}`
  );
  for (const s of Object.keys(counts)) {
    if (!rules.severities.includes(s)) parts.push(`${s.slice(0, 4)} ${counts[s]}`);
  }
  // The blocker tint follows what still gates — a rejected finding is open
  // in the file but no longer a blocker; it counts under `rej` instead.
  const gating = reviewStore.blockingCounts(props.card.id);
  const blockers = rules.blocking.reduce((n, s) => n + (gating[s] ?? 0), 0);
  const rejected = st.findings.filter(
    (f) => f.status === 'open' && reviewStore.verdictFor(props.card.id, f.id)?.verdict === 'rejected'
  ).length;
  const round = st.round !== null ? `r${st.round}/${rules.maxRounds}` : null;
  const text = `${round ? `${round} ` : ''}${parts.join(' · ')}${rejected ? ` · rej ${rejected}` : ''}`;
  const title = `Open review findings — round ${st.round ?? '—'} of ${rules.maxRounds}: ${parts.join(', ')}${rejected ? ` (${rejected} rejected by review-checker)` : ''}`;
  return { text, title, blockers };
});

/** The card's orchestrator run (P7): who runs it, which session, how the
 * run is doing and for how long — all derived from claims.json and the
 * activity ledger, never stored on the card itself. `claimsStore.now`
 * ticks so the state and durations stay live. */
const runEntries = computed(() => {
  const claim = claimsStore.claimFor(props.card.id);
  const sessionId = claim?.sessionId || props.card.session?.sessionId || '';
  return activityStore.entriesForRun(sessionId, props.card.title);
});
const runInfo = computed(() =>
  runInfoFor(props.card, claimsStore.claimFor(props.card.id), runEntries.value, claimsStore.now)
);

/** Subagents the run delegated to — `delegate` ledger entries keyed to
 * the run's sessionId. No events, no rows. */
const subagents = computed(() =>
  runInfo.value
    ? subagentsFor(runInfo.value.sessionId, runEntries.value, claimsStore.now)
    : []
);

const RUN_LABEL: Record<string, string> = {
  running: 'идёт',
  waiting: 'ждёт',
  finished: 'завершён',
};

const SUB_LABEL: Record<string, string> = {
  running: 'идёт',
  done: 'завершён',
  failed: 'ошибка',
  cancelled: 'отменён',
};

function subTitle(s: SubagentRow): string {
  const parts = [s.name, s.goal, s.outcome].filter(Boolean);
  return parts.join(' — ');
}

onMounted(() => {
  const pid = board.projectIdForCard(props.card);
  const proj = pid ? projectsStore.projects.find((p) => p.id === pid) : null;
  if (proj) artifactsStore.ensureLoaded(props.card.id, proj.path);
});

const PRIORITY_LABEL: Record<string, string> = { high: 'high', medium: 'med', low: 'low' };

/** The blocked badge names what blocks the card when the reason carries
 * the pm tool's provenance format `pm: blocked by <id8>` (F10.4); any other
 * reason stays the plain `blocked` chip with the text in the tooltip. */
const blockedBadge = computed(() => {
  const m = /^pm:\s*blocked by\s+(\S+)/i.exec(props.card.blockedReason || '');
  return m ? `blocked by ${m[1].slice(0, 8)}` : 'blocked';
});

/** id8 (+title when the card is on the board) for the relation chips'
 * tooltips — full uuids don't fit a hover. */
function relTitles(ids: string[]): string {
  return ids
    .map((id) => {
      const c = board.cards.find((x) => x.id === id);
      return c ? `${id.slice(0, 8)} ${c.title}` : id.slice(0, 8);
    })
    .join(', ');
}

function toggleMenu(event: Event) {
  event.stopPropagation();
  statusOpen.value = false;
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    document.addEventListener('click', closeMenus, { once: true });
  }
}

function toggleStatusMenu(event: Event) {
  event.stopPropagation();
  menuOpen.value = false;
  statusOpen.value = !statusOpen.value;
  if (statusOpen.value) {
    document.addEventListener('click', closeMenus, { once: true });
  }
}

function closeMenus() {
  menuOpen.value = false;
  statusOpen.value = false;
}

function onCardClick() {
  emit('open', props.card);
}

function onKeydown(event: KeyboardEvent) {
  // Card-level keyboard support (N7): Enter opens, Alt+←/→ moves between
  // stages, Alt+↑/↓ reorders inside the stage, Esc closes an open menu.
  // Plain arrows stay free for tab traversal / scrolling.
  if (event.key === 'Escape' && (menuOpen.value || statusOpen.value)) {
    event.preventDefault();
    closeMenus();
    return;
  }
  if (event.key === 'Enter' && !event.altKey) {
    event.preventDefault();
    emit('open', props.card);
    return;
  }
  if (!event.altKey) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    emit('move', props.card.id, prevStage());
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    emit('move', props.card.id, nextStage());
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    emit('reorder', props.card.id, -1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    emit('reorder', props.card.id, 1);
  }
}

function prevStage(): BoardStageId {
  const ids = BOARD_STAGES.map((c) => c.id);
  return ids[Math.max(0, ids.indexOf(props.card.stage) - 1)];
}

function nextStage(): BoardStageId {
  const ids = BOARD_STAGES.map((c) => c.id);
  return ids[Math.min(ids.length - 1, ids.indexOf(props.card.stage) + 1)];
}

function onDragStart(event: DragEvent) {
  closeMenus();
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/x-board-card', props.card.id);
    event.dataTransfer.setData('text/plain', props.card.title);
    event.dataTransfer.effectAllowed = 'move';
  }
  emit('dragstart', props.card.id, event);
}

function moveTo(stage: BoardStageId) {
  closeMenus();
  emit('move', props.card.id, stage);
}

function pickStatus(status: CardStatus) {
  closeMenus();
  emit('set-status', props.card.id, status);
}

function toggleFlag(flag: 'blocked' | 'cancelled') {
  closeMenus();
  emit('set-flag', props.card.id, flag, !props.card[flag]);
}

function onDuplicate() {
  closeMenus();
  emit('duplicate', props.card.id);
}

function onRemove() {
  closeMenus();
  emit('remove', props.card.id);
}

onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenus);
});
</script>

<template>
  <article
    class="board-card"
    :class="[`prio-${card.priority}`, {
      'has-menu': menuOpen || statusOpen,
      'flag-blocked': card.blocked,
      'flag-cancelled': card.cancelled,
    }]"
    :data-card-id="card.id"
    draggable="true"
    tabindex="0"
    :aria-label="`${card.title} — ${stageLabel(card.stage)}`"
    @click="onCardClick"
    @keydown="onKeydown"
    @dragstart="onDragStart"
    @dragend="emit('dragend')"
  >
    <div class="card-top">
      <span class="card-title">{{ card.title || 'Untitled card' }}</span>
      <button
        class="card-menu-btn"
        aria-label="Card actions"
        :aria-expanded="menuOpen"
        title="Card actions"
        @click="toggleMenu"
        @keydown.stop
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    </div>

    <div class="card-meta">
      <!-- In-stage status chip: click opens the stage's status picker.
           backlog/done have no status, so no chip renders there. -->
      <button
        v-if="stageStatuses.length"
        class="status-chip"
        :class="`st-${card.status}`"
        :aria-label="`Status: ${card.status} — change`"
        :aria-expanded="statusOpen"
        :title="`Status in ${stageLabel(card.stage)}: ${card.status} — click to change`"
        @click="toggleStatusMenu"
        @keydown.stop
      >{{ card.status }}</button>
      <span v-if="statusToken" class="meta-chip st-token" :class="`tok-${statusToken.toLowerCase()}`"
        data-testid="card-status-token"
        :title="`STATUS: ${statusToken} — from .acp/cards artifacts`">{{ statusToken }}</span>
      <span v-if="reviewInfo" class="meta-chip review" :class="{ 'has-blockers': reviewInfo.blockers > 0 }"
        data-testid="review-findings"
        :title="reviewInfo.title">{{ reviewInfo.text }}</span>
      <span v-if="stageRole" class="meta-chip role" data-testid="card-role-badge"
        :title="`Stage role: ${stageRole.label} (${stageRole.cli})`">{{ stageRole.label }}</span>
      <span v-if="stageRole && !stageRoleHasRunner" class="meta-chip no-runner"
        data-testid="card-no-runner"
        :title="`No configured agent runs CLI '${stageRole.cli}'`">no runner for role</span>
      <span v-if="card.blocked" class="meta-chip flag blocked"
        data-testid="card-blocked-badge"
        :title="card.blockedReason ? `Blocked: ${card.blockedReason}` : 'Flagged blocked'"
      >{{ blockedBadge }}</span>
      <span v-if="card.cancelled" class="meta-chip flag cancelled" title="Flagged cancelled">cancelled</span>
      <span v-if="unassigned" class="meta-chip unassigned" title="No project">unassigned</span>
      <span v-if="card.project" class="meta-chip" :title="card.project">{{ card.project }}</span>
      <span v-if="card.agent" class="meta-chip agent" :title="card.agent">{{ card.agent }}</span>
      <span class="meta-chip prio" :class="`p-${card.priority}`">{{ PRIORITY_LABEL[card.priority] }}</span>
      <span v-if="card.dependsOn.length" class="meta-chip rel" :title="`Depends on: ${relTitles(card.dependsOn)}`">dep {{ card.dependsOn.length }}</span>
      <span v-if="card.blocks.length" class="meta-chip rel" :title="`Blocks: ${relTitles(card.blocks)}`">blocks {{ card.blocks.length }}</span>
      <span v-if="card.conflictsWith.length" class="meta-chip rel conflict" :title="`Conflicts with: ${relTitles(card.conflictsWith)}`">conflict {{ card.conflictsWith.length }}</span>
      <span v-if="card.session" class="meta-chip sess" title="Attached session">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 17l6-5-6-5M12 19h8" />
        </svg>
        session
      </span>
      <span v-if="card.links.length" class="meta-chip">{{ card.links.length }} link{{ card.links.length === 1 ? '' : 's' }}</span>
      <span class="meta-stamp">{{ fmtStamp(card.updatedAt) }}</span>
    </div>

    <p v-if="card.description" class="card-desc">{{ card.description }}</p>

    <!-- Orchestrator run + subagents (P7): derived from claims.json and
         `delegate` ledger entries keyed to the run's sessionId. -->
    <div v-if="runInfo" class="run-block" data-testid="run-block">
      <div class="run-line">
        <span class="run-state" :class="`rs-${runInfo.state}`" data-testid="run-state">{{ RUN_LABEL[runInfo.state] }}</span>
        <span class="run-agent" :title="`Orchestrator: ${runInfo.agentName}`">{{ runInfo.agentName || '—' }}</span>
        <span v-if="runInfo.sessionId" class="run-sess" :title="`Session ${runInfo.sessionId}`">{{ runInfo.sessionId }}</span>
        <span v-if="runInfo.durationMs != null" class="run-dur" data-testid="run-duration">{{ fmtDur(runInfo.durationMs) }}</span>
      </div>
      <ul v-if="subagents.length" class="sub-list" data-testid="subagent-list">
        <li
          v-for="s in subagents"
          :key="s.key"
          class="sub-row"
          data-testid="subagent-row"
          :data-state="s.state"
          :title="subTitle(s)"
        >
          <span class="sub-name">{{ s.name }}</span>
          <span class="sub-state" :class="`ss-${s.state}`">{{ SUB_LABEL[s.state] }}</span>
          <span v-if="s.durationMs != null" class="sub-dur">{{ fmtDur(s.durationMs) }}</span>
        </li>
      </ul>
    </div>

    <!-- Status picker — the compact per-card control from the brief: click
         the chip, pick one of this stage's statuses, no modal. -->
    <div v-if="statusOpen" class="card-menu status-menu" role="menu" @click.stop>
      <div class="menu-label">Status in {{ stageLabel(card.stage) }}</div>
      <button
        v-for="s in stageStatuses"
        :key="s"
        class="menu-item"
        :class="{ current: card.status === s }"
        role="menuitem"
        @click="pickStatus(s)"
      >{{ s }}</button>
    </div>

    <div v-if="menuOpen" class="card-menu" role="menu" @click.stop>
      <div class="menu-label">Move to</div>
      <button
        v-for="col in otherStages"
        :key="col.id"
        class="menu-item"
        role="menuitem"
        @click="moveTo(col.id)"
      >{{ col.label }}</button>
      <div class="menu-sep" />
      <button class="menu-item" role="menuitem" @click="toggleFlag('blocked')">
        {{ card.blocked ? 'Clear blocked flag' : 'Flag blocked' }}
      </button>
      <button class="menu-item" role="menuitem" @click="toggleFlag('cancelled')">
        {{ card.cancelled ? 'Clear cancelled flag' : 'Flag cancelled' }}
      </button>
      <div class="menu-sep" />
      <button class="menu-item" role="menuitem" @click="onDuplicate">Duplicate</button>
      <button class="menu-item danger" role="menuitem" @click="onRemove">Delete…</button>
    </div>
  </article>
</template>

<style scoped>
.board-card {
  position: relative;
  padding: 0.375rem 0.5rem 0.375rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  cursor: pointer;
}

.board-card:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-color: var(--border-color, #e3dbcf);
}

.board-card:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
  border-color: var(--text-accent, #c2532f);
}

.board-card[draggable='true'] {
  user-select: none;
}

/* Flag marks: a blocked card keeps its stage but carries a danger edge;
   a cancelled card is dimmed with a struck title. Both stay out of any
   future auto-pickup. */
.board-card.flag-blocked {
  border-left: 2px solid var(--bg-danger, #b3402e);
}

.board-card.flag-cancelled .card-title {
  color: var(--text-muted, #a39a8e);
  text-decoration: line-through;
}

.card-top {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
}

.card-title {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 550;
  line-height: 1.3;
  letter-spacing: -0.005em;
  color: var(--text-primary, #2b2723);
  overflow-wrap: anywhere;
}

.card-menu-btn {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  cursor: pointer;
  opacity: 0;
}

.board-card:hover .card-menu-btn,
.board-card:focus-within .card-menu-btn,
.board-card.has-menu .card-menu-btn {
  opacity: 1;
}

.card-menu-btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.25rem;
}

/* The in-stage status chip doubles as the status picker's trigger, so it
   is a real button — sized like a meta chip, touch-sized on phones. */
.status-chip {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  letter-spacing: 0.02em;
  padding: 0.0625rem 0.3rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-accent, #c2532f);
  cursor: pointer;
  max-width: 9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-chip:hover {
  border-color: var(--text-accent, #c2532f);
}

.status-chip:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
}

.status-chip.st-done,
.status-chip.st-accepted {
  color: var(--text-secondary, #6b6259);
}

.meta-chip {
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  letter-spacing: 0.02em;
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-radius: var(--radius-sm, 4px);
  padding: 0.0625rem 0.3rem;
  max-width: 9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-chip.prio {
  text-transform: uppercase;
}

.meta-chip.p-high {
  color: var(--bg-danger, #b3402e);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.meta-chip.role {
  color: var(--text-accent, #c2532f);
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
}

.meta-chip.no-runner {
  color: var(--bg-danger, #b3402e);
  border: 1px solid var(--bg-danger, #b3402e);
  background: transparent;
}

.meta-chip.flag.blocked {
  color: var(--bg-danger, #b3402e);
}

.meta-chip.flag.cancelled,
.meta-chip.unassigned {
  color: var(--text-muted, #a39a8e);
}

.meta-chip.rel.conflict {
  color: var(--bg-danger, #b3402e);
}

/* Review-findings counter: one flat chip; goes danger-coloured while a
   blocking severity is open. */
.meta-chip.review {
  max-width: none;
}

.meta-chip.review.has-blockers {
  color: var(--bg-danger, #b3402e);
}

/* STATUS-token badge (W6-A): mirrors the drawer's token colors. */
.meta-chip.st-token.tok-approve,
.meta-chip.st-token.tok-done {
  color: var(--bg-success, #5a7d4f);
}

.meta-chip.st-token.tok-changes_required {
  color: var(--text-accent, #c2532f);
}

.meta-chip.st-token.tok-blocked {
  color: var(--bg-danger, #b3402e);
}

.meta-chip.sess {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  color: var(--text-accent, #c2532f);
}

.meta-stamp {
  margin-left: auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.card-desc {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--text-secondary, #6b6259);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Orchestrator run + subagent rows (P7). Same chip vocabulary as the meta
   row; the block reads as one fact line plus one line per subagent. */
.run-block {
  margin-top: 0.25rem;
  padding: 0.1875rem 0.375rem;
  border-left: 2px solid var(--border-color, #e3dbcf);
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.run-line,
.sub-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  letter-spacing: 0.02em;
}

.run-state {
  flex: 0 0 auto;
  padding: 0.0625rem 0.3rem;
  border-radius: var(--radius-sm, 4px);
  color: var(--text-secondary, #6b6259);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.run-state.rs-running {
  color: var(--text-accent, #c2532f);
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
}

.run-state.rs-finished {
  color: var(--bg-success, #5a7d4f);
}

.run-agent,
.sub-name {
  min-width: 0;
  max-width: 9rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary, #2b2723);
}

.run-sess {
  min-width: 0;
  max-width: 8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-muted, #a39a8e);
}

.run-dur,
.sub-dur {
  margin-left: auto;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #a39a8e);
}

.sub-list {
  list-style: none;
  margin: 0;
  padding: 0 0 0 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.sub-state {
  flex: 0 0 auto;
  color: var(--text-muted, #a39a8e);
}

.sub-state.ss-running {
  color: var(--text-accent, #c2532f);
}

.sub-state.ss-done {
  color: var(--bg-success, #5a7d4f);
}

.sub-state.ss-failed,
.sub-state.ss-cancelled {
  color: var(--bg-danger, #b3402e);
}

/* Card menus — "Move to"/flags and the status picker share one look. The
   status menu anchors under the chip (left), the actions menu under ⋮. */
.card-menu {
  position: absolute;
  top: 1.625rem;
  right: 0.375rem;
  z-index: 30;
  min-width: 9.5rem;
  padding: 0.25rem;
  background: var(--bg-main, #fbf8f3);
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
}

.status-menu {
  right: auto;
  left: 0.375rem;
}

.menu-label {
  padding: 0.25rem 0.5rem 0.125rem;
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.menu-item {
  display: block;
  width: 100%;
  min-height: 26px;
  padding: 0 0.5rem;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  font-family: inherit;
  font-size: 0.75rem;
  text-align: left;
  color: var(--text-primary, #2b2723);
  cursor: pointer;
}

.menu-item:hover,
.menu-item:focus-visible {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  outline: none;
}

.menu-item.current {
  color: var(--text-accent, #c2532f);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.menu-item.danger {
  color: var(--bg-danger, #b3402e);
}

.menu-sep {
  height: 1px;
  margin: 0.25rem 0.375rem;
  background: var(--border-faint, rgba(43, 39, 35, 0.09));
}

@media (max-width: 800px) {
  .card-menu-btn {
    opacity: 1;
    width: 44px;
    height: 44px;
  }

  .status-chip {
    min-height: 44px;
    padding: 0 0.5rem;
  }

  .menu-item {
    min-height: 44px;
    display: flex;
    align-items: center;
  }
}
</style>
