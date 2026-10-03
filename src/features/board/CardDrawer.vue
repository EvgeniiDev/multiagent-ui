<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useBoardStore, type BoardCard } from '../../stores/board';
import { useSessionStore } from '../../stores/session';
import { useConfigStore } from '../../stores/config';
import { useProjectsStore } from '../../stores/projects';
import { useRolesStore } from '../../stores/roles';
import { useReviewStore } from '../../stores/review';
import { projectName } from '../../stores/activity';
import {
  useArtifactsStore,
  pickStatusArtifact,
  proposeTransition,
  parseStatusToken,
  parseChecklist,
  reviewRoundOf,
  CHECKLIST_FILE,
  type CardArtifact,
} from '../../stores/artifacts';
import { BOARD_STAGES, PRIORITIES, statusesForStage, stageLabel } from './columns';
import { fmtStamp } from './format';
import ExecutionPanel from './ExecutionPanel.vue';
import PreparationPanel from './PreparationPanel.vue';
import { useCardDraft, draftFromCard } from './useCardDraft';

const props = defineProps<{
  cardId: string;
}>();

const emit = defineEmits<{
  close: [];
  'open-session': [session: { agentName: string; sessionId: string }];
  'open-card': [cardId: string];
  /** Managed-run navigation: jump to the chat view's workflow panel. */
  'open-workflow': [target: { cardId: string; runId: string }];
}>();

const board = useBoardStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const projectsStore = useProjectsStore();
const rolesStore = useRolesStore();
const reviewStore = useReviewStore();
const artifactsStore = useArtifactsStore();

const card = computed(() => board.cards.find((c) => c.id === props.cardId) ?? null);
/** Server-owned lifecycle: the managed card's stage/status/flags/project/
 * session come from the execution engine, not the draft. */
const isManaged = computed(() => card.value?.execution?.managed === true);
const managedReason =
  'managed by the execution engine — controlled in the Managed execution section below';

// Local draft, debounced back into the store — the whole state machine
// (edited-field deltas, switch-flush, unmount flush) lives in
// useCardDraft.ts so the identical logic is behavioral-tested in node.
// Edits are never lost to a misclick outside the drawer — there is no
// cancel path by design.
const {
  draft,
  lastSavedAt,
  markDirty,
  flush,
  flushNow,
  resetToCard,
  onStagePicked,
} = useCardDraft({
  card,
  cardId: computed(() => props.cardId),
  findCard: (id) => board.cards.find((c) => c.id === id) ?? null,
  moveCard: (id, stage) => board.moveCard(id, stage),
  setCardStatus: (id, status) => board.setCardStatus(id, status),
  setCardFlag: (id, flag, value, reason) => board.setCardFlag(id, flag, value, reason),
  updateCard: (id, patch) => board.updateCard(id, patch),
  onRefused: (reason) => alert(reason),
});

const agents = computed(() => configStore.allAgentNames);

const sessionOptions = computed(() =>
  [...sessionStore.savedSessions].sort((a, b) => b.lastUpdated - a.lastUpdated)
);

const attachedSession = computed(() => {
  const c = card.value;
  if (!c?.session) return null;
  return (
    sessionStore.savedSessions.find(
      (s) => s.agentName === c.session!.agentName && s.sessionId === c.session!.sessionId
    ) ?? null
  );
});

function onSessionPicked() {
  // When a session is attached and the project is still empty, default the
  // project to the session's cwd last segment (spec: project defaults to
  // the last path segment).
  if (!draft.value.project.trim() && attachedSession.value?.cwd && !isManaged.value) {
    draft.value.project = projectName(attachedSession.value.cwd);
    markDirty('project');
  }
  markDirty('sessionKey');
}

function addLink() {
  draft.value.links.push({ label: '', url: '' });
  markDirty('links');
}

function removeLink(i: number) {
  draft.value.links.splice(i, 1);
  markDirty('links');
}

function onDuplicate() {
  flushNow();
  const copy = board.duplicateCard(props.cardId);
  if (copy) emit('close');
}

function onRemove() {
  const c = card.value;
  if (!c) return;
  if (c.execution?.managed === true) {
    alert('This card is managed by the execution engine — its lifecycle is controlled in the managed execution section.');
    return;
  }
  if (confirm(`Delete "${c.title || 'Untitled card'}"?`)) {
    board.removeCard(c.id);
    emit('close');
  }
}

function onOpenSession() {
  const s = attachedSession.value;
  if (s) emit('open-session', { agentName: s.agentName, sessionId: s.sessionId });
}

// ---- card graph (F10.3 fields) ----------------------------------------------
//
// Read-only view of this card's edges: the pm role owns dependsOn/blocks/
// conflictsWith on the board; the drawer resolves ids to id8 + title and
// offers a jump into the linked card's drawer.

function relCard(id: string): BoardCard | null {
  return board.cards.find((c) => c.id === id) ?? null;
}

function relLabel(id: string): string {
  const c = relCard(id);
  return c ? `${id.slice(0, 8)} ${c.title}` : `${id.slice(0, 8)} (gone)`;
}

interface RelGroup {
  key: 'dependsOn' | 'blocks' | 'conflictsWith';
  label: string;
  ids: string[];
}

const relGroups = computed<RelGroup[]>(() => {
  const c = card.value;
  if (!c) return [];
  const all: RelGroup[] = [
    { key: 'dependsOn', label: 'depends on', ids: c.dependsOn },
    { key: 'blocks', label: 'blocks', ids: c.blocks },
    { key: 'conflictsWith', label: 'conflicts with', ids: c.conflictsWith },
  ];
  return all.filter((g) => g.ids.length > 0);
});

/** `pm:` is the pm tool's provenance prefix on blockedReason — its marks
 * are graph-derived; anything else is a human's/dispatcher's text. */
const pmBlocked = computed(() =>
  (card.value?.blockedReason || '').startsWith('pm:')
);

function onEsc(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

// ---- artifacts (card-as-pipeline, W6-A) -------------------------------------
//
// Artifacts live on the host at <projectPath>/.acp/cards/<cardId>/ and are
// read through the bridge by the artifacts store. The block below lists
// them, shows the card's current STATUS token, and offers the transition
// the token proposes — applied through the same store mutations the manual
// stage/status controls use (moveCard / setCardStatus / setCardFlag), never
// a direct document write.

/** The card's registry project path; null when the free-text project label
 * resolves to nothing (artifacts then can't be located). */
const cardProjectPath = computed(() => {
  const c = card.value;
  if (!c) return null;
  const pid = board.projectIdForCard(c);
  const proj = pid ? projectsStore.projects.find((p) => p.id === pid) : null;
  return proj?.path ?? null;
});

const artState = computed(() => artifactsStore.stateFor(props.cardId));
const openArtifact = ref<CardArtifact | null>(null);

/** The artifact whose token currently speaks for the card — stage-aware
 * (in reviewtest it is the highest `05_review_rN` round). */
const tokenArtifact = computed(() =>
  pickStatusArtifact(card.value?.stage ?? 'backlog', artState.value.artifacts)
);
const reviewRound = computed(() => reviewRoundOf(artState.value.artifacts));

// ---- plan checklist (W15 plan-queue) -----------------------------------------
//
// `03_checklist.md` is derived from the plan once, then its `- [ ]` / `- [x]`
// marks are the run's progress state (executor / hand edits — never the
// panel's). The block below is a read-only view of those marks; the file
// itself stays reachable as an ordinary artifact row.

const checklistItems = computed(() => {
  const a = artState.value.artifacts.find((x) => x.name === CHECKLIST_FILE);
  return a ? parseChecklist(a.content) : [];
});
const checklistDone = computed(
  () => checklistItems.value.filter((i) => i.done).length
);

// ---- review findings (review cycle) ------------------------------------------
//
// The structured findings file `.acp/cards/<id>/review_findings.json` is
// mirrored into the review store by the artifacts loader. This block shows
// the per-severity open counts, the round, and each finding's status — the
// same state the `agent_tested` gate and `boardctl review` read.

const reviewState = computed(() => reviewStore.stateFor(props.cardId));
const reviewRules = computed(() => rolesStore.reviewRulesForStage('reviewtest'));
const reviewCounts = computed(() => reviewStore.openCounts(props.cardId));
/** The checker's effective verdict on a finding (latest row wins; null =
 * unvetted). Rejected findings stop gating but stay in history — the row
 * shows the verdict and the reason, never silently dropped. */
const verdictFor = (findingId: string) =>
  reviewStore.verdictFor(props.cardId, findingId);
const reviewCountsLine = computed(() => {
  const c = reviewCounts.value;
  const open = Object.values(c).reduce((a, b) => a + b, 0);
  const parts = reviewRules.value.severities.map((s) => `${s} ${c[s] ?? 0}`);
  return `${open} open — ${parts.join(' · ')}`;
});
const reviewGateHint = computed(() => reviewStore.gateRefusal(props.cardId));

const proposal = computed(() =>
  card.value
    ? proposeTransition(
        card.value.stage,
        reviewRound.value,
        tokenArtifact.value?.token ?? null,
        tokenArtifact.value?.tokenDetail ?? ''
      )
    : { kind: 'none' as const, label: '' }
);

watch(
  [() => props.cardId, cardProjectPath],
  () => {
    openArtifact.value = null;
    if (card.value && cardProjectPath.value) {
      artifactsStore.ensureLoaded(props.cardId, cardProjectPath.value);
    }
  },
  { immediate: true }
);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function onOpenArtifact(a: CardArtifact) {
  openArtifact.value = openArtifact.value?.name === a.name ? null : a;
}

/** "Обновить": re-read the artifact dir over the bridge and re-sync the
 * draft from the card (the board store itself is already live). */
function onRefreshArtifacts() {
  if (cardProjectPath.value) {
    void artifactsStore.refresh(props.cardId, cardProjectPath.value).then(() => {
      // Artifact objects are replaced wholesale — re-point the open viewer
      // at the fresh record so it doesn't show pre-refresh content.
      const name = openArtifact.value?.name;
      if (name) {
        openArtifact.value =
          artState.value.artifacts.find((a) => a.name === name) ?? null;
      }
    });
  }
  if (card.value) draft.value = draftFromCard(card.value);
}

/** "Применить": the proposed transition via the board's own mutations —
 * the same code path as a manual move/status pick in the UI. */
function onApplyTransition() {
  const c = card.value;
  const p = proposal.value;
  if (!c || p.kind === 'none') return;
  flush();
  let r: { ok: boolean; reason?: string } = { ok: true };
  if (p.kind === 'move') r = board.moveCard(c.id, p.to);
  else if (p.kind === 'status') r = board.setCardStatus(c.id, p.status);
  else r = board.setCardFlag(c.id, 'blocked', true, p.reason);
  if (!r.ok && r.reason) alert(r.reason);
  resetToCard();
}

onMounted(() => {
  window.addEventListener('keydown', onEsc, true);
  // e2e seam — same pattern as window.__projects / window.__roles.
  (window as unknown as { __pipeline: unknown }).__pipeline = {
    proposeTransition,
    parseStatusToken,
    pickStatusArtifact,
    reviewRoundOf,
  };
  (window as unknown as { __artifacts: unknown }).__artifacts = artifactsStore;
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc, true);
  // The pending-draft flush on unmount is the composable's own dispose —
  // it flushes against the still-current card id.
});
</script>

<template>
  <aside v-if="card" class="card-drawer" aria-label="Card editor">
    <header class="drawer-head">
      <span class="drawer-title">Card</span>
      <span class="drawer-id mono">{{ card.id.slice(0, 8) }}</span>
      <span class="drawer-stage mono">{{ stageLabel(card.stage) }}<template v-if="card.status"> · {{ card.status }}</template></span>
      <button class="drawer-close" aria-label="Close card editor" title="Close (Esc)" @click="emit('close')">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div class="drawer-body">
      <label class="field">
        <span class="field-label">Title</span>
        <input v-model="draft.title" data-field="title" class="f-input" type="text"
          placeholder="Card title" @input="markDirty('title')" />
      </label>

      <label class="field">
        <span class="field-label">Description</span>
        <textarea v-model="draft.description" data-field="description" class="f-input" rows="3"
          placeholder="What needs doing" @input="markDirty('description')" />
      </label>

      <div class="field-row">
        <label class="field">
          <span class="field-label">Project<template v-if="isManaged"> · managed</template></span>
          <input v-model="draft.project" data-field="project" class="f-input mono" type="text"
            list="board-project-list" placeholder="project" :disabled="isManaged"
            :title="isManaged ? managedReason : ''" @input="markDirty('project')" />
          <datalist id="board-project-list">
            <option v-for="p in board.projectOptions" :key="p" :value="p" />
          </datalist>
        </label>

        <label class="field">
          <span class="field-label">Agent</span>
          <select v-model="draft.agent" data-field="agent" class="f-input" @change="markDirty('agent')">
            <option value="">Unassigned</option>
            <option v-for="a in agents" :key="a" :value="a">{{ a }}</option>
          </select>
        </label>
      </div>

      <div class="field">
        <span class="field-label">Priority</span>
        <div class="prio-seg" role="radiogroup" aria-label="Priority">
          <button
            v-for="p in PRIORITIES"
            :key="p.id"
            class="seg-btn"
            :class="{ active: draft.priority === p.id }"
            role="radio"
            :aria-checked="draft.priority === p.id"
            @click="draft.priority = p.id; markDirty('priority')"
          >{{ p.label }}</button>
        </div>
      </div>

      <div class="field-row">
        <label class="field">
          <span class="field-label">Stage<template v-if="isManaged"> · managed</template></span>
          <select v-model="draft.stage" data-field="stage" class="f-input" :disabled="isManaged"
            :title="isManaged ? managedReason : ''" @change="onStagePicked">
            <option v-for="c in BOARD_STAGES" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Status<template v-if="isManaged"> · managed</template></span>
          <select v-model="draft.status" data-field="status" class="f-input"
            :disabled="!statusesForStage(draft.stage).length || isManaged"
            :title="isManaged ? managedReason : ''" @change="markDirty('status')">
            <option v-if="!statusesForStage(draft.stage).length" :value="null">—</option>
            <option v-for="s in statusesForStage(draft.stage)" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </div>

      <div class="field">
        <span class="field-label">Flags<template v-if="isManaged"> · managed</template></span>
        <div class="prio-seg" role="group" aria-label="Card flags">
          <button
            class="seg-btn flag-btn"
            :class="{ active: draft.blocked }"
            :aria-pressed="draft.blocked"
            :disabled="isManaged"
            :title="isManaged ? managedReason : ''"
            data-field="blocked"
            @click="draft.blocked = !draft.blocked; markDirty('blocked')"
          >blocked</button>
          <button
            class="seg-btn flag-btn"
            :class="{ active: draft.cancelled }"
            :aria-pressed="draft.cancelled"
            :disabled="isManaged"
            :title="isManaged ? managedReason : ''"
            data-field="cancelled"
            @click="draft.cancelled = !draft.cancelled; markDirty('cancelled')"
          >cancelled</button>
        </div>
      </div>

      <label v-if="draft.blocked" class="field">
        <span class="field-label">Blocked reason</span>
        <input v-model="draft.blockedReason" data-field="blockedReason" class="f-input" type="text"
          placeholder="what blocks it (optional card ref)" :disabled="isManaged"
          :title="isManaged ? managedReason : ''" @input="markDirty('blockedReason')" />
      </label>

      <label class="field">
        <span class="field-label">Acceptance criteria</span>
        <textarea v-model="draft.acceptance" data-field="acceptance" class="f-input" rows="4"
          placeholder="One per line" @input="markDirty('acceptance')" />
      </label>

      <label class="field">
        <span class="field-label">Verification steps</span>
        <textarea v-model="draft.verification" data-field="verification" class="f-input" rows="4"
          placeholder="How to prove it works" @input="markDirty('verification')" />
      </label>

      <div class="field">
        <span class="field-label">Links</span>
        <div v-for="(link, i) in draft.links" :key="i" class="link-row">
          <input v-model="link.label" class="f-input link-label" type="text" placeholder="label"
            aria-label="Link label" @input="markDirty('links')" />
          <input v-model="link.url" class="f-input mono link-url" type="text" placeholder="https://…"
            aria-label="Link URL" @input="markDirty('links')" />
          <button class="link-del" aria-label="Remove link" @click="removeLink(i)">×</button>
        </div>
        <button class="link-add" @click="addLink">+ Add link</button>
      </div>

      <div v-if="relGroups.length || pmBlocked" class="field" data-testid="card-relations">
        <span class="field-label">Relations</span>
        <div v-for="g in relGroups" :key="g.key" class="rel-row">
          <span class="rel-kind mono">{{ g.label }}</span>
          <button
            v-for="rid in g.ids"
            :key="rid"
            class="rel-chip mono"
            :class="{ gone: !relCard(rid) }"
            :title="relLabel(rid)"
            @click="emit('open-card', rid)"
          >{{ rid.slice(0, 8) }}</button>
        </div>
        <div v-if="pmBlocked" class="rel-row">
          <span class="rel-kind mono">mark</span>
          <span class="rel-pm mono" title="pm-derived blocked flag — cleared by the next pm run when the dependency finishes">pm: blocked</span>
          <span class="rel-note" :title="card?.blockedReason">{{ card?.blockedReason }}</span>
        </div>
      </div>

      <label class="field">
        <span class="field-label">Attached session<template v-if="isManaged"> · managed</template></span>
        <select v-model="draft.sessionKey" data-field="session" class="f-input" :disabled="isManaged"
          :title="isManaged ? managedReason : ''" @change="onSessionPicked">
          <option value="">None</option>
          <option
            v-for="s in sessionOptions"
            :key="`${s.agentName}::${s.sessionId}`"
            :value="`${s.agentName}::${s.sessionId}`"
          >{{ s.agentName }} · {{ s.title }}</option>
        </select>
      </label>

      <PreparationPanel :card-id="card.id" />

      <ExecutionPanel
        :card-id="card.id"
        @open-workflow="(t) => emit('open-workflow', t)"
      />

      <div
        v-if="reviewState && (reviewState.findings.length || reviewState.round !== null || reviewState.error)"
        class="field"
        data-testid="review-block"
      >
        <div class="art-head">
          <span class="field-label">Review findings</span>
          <span
            class="status-token mono"
            data-testid="review-round"
            :title="`Current review round — limit ${reviewRules.maxRounds}`"
          >round {{ reviewState.round ?? '—' }} / {{ reviewRules.maxRounds }}</span>
        </div>
        <p v-if="reviewState.error" class="art-error" data-testid="review-error">{{ reviewState.error }}</p>
        <template v-else>
          <p class="art-note" data-testid="review-counts">{{ reviewCountsLine }}</p>
          <p v-if="reviewGateHint" class="art-note gate-note" data-testid="review-gate">{{ reviewGateHint }}</p>
          <p v-if="reviewState.verdictsError" class="art-error" data-testid="verdict-error">{{ reviewState.verdictsError }}</p>
          <ul v-if="reviewState.findings.length" class="art-list" data-testid="review-list">
            <li
              v-for="f in reviewState.findings"
              :key="f.id"
              class="find-row mono"
              :class="{
                'find-closed': f.status === 'closed',
                'find-rejected': verdictFor(f.id)?.verdict === 'rejected',
              }"
            >
              <span class="find-sev" :class="`sev-${f.severity}`">{{ f.severity }}</span>
              <span class="find-text" :title="f.where">{{ f.text || f.id }}</span>
              <span
                v-if="verdictFor(f.id)"
                class="find-verd"
                :class="`verd-${verdictFor(f.id)!.verdict}`"
                :data-verdict="verdictFor(f.id)!.verdict"
                :title="`${verdictFor(f.id)!.checker || 'review-checker'}: ${verdictFor(f.id)!.reason || 'no reason'}`"
              >{{ verdictFor(f.id)!.verdict }}</span>
              <span class="find-st">{{
                f.status === 'closed' ? `closed r${f.closedInRound ?? f.round}` : `open · r${f.round}`
              }}</span>
            </li>
          </ul>
        </template>
      </div>

      <div class="field artifacts" data-testid="artifacts-block">
        <div class="art-head">
          <span class="field-label">Artifacts</span>
          <span
            class="status-token mono"
            :class="tokenArtifact?.token ? `tok-${tokenArtifact.token.toLowerCase()}` : 'tok-none'"
            data-testid="status-token"
            :title="tokenArtifact ? `STATUS token from ${tokenArtifact.name}` : 'No STATUS token in the card artifacts'"
          >STATUS: {{ tokenArtifact?.token ?? '—' }}</span>
          <button
            class="art-refresh"
            data-testid="artifacts-refresh"
            title="Re-read artifacts and board state"
            :disabled="!cardProjectPath || artState.phase === 'loading'"
            @click="onRefreshArtifacts"
          >↻ Refresh</button>
        </div>

        <p v-if="!cardProjectPath" class="art-note" data-testid="artifacts-noproject">
          No project on this card — artifacts live under &lt;projectPath&gt;/.acp/cards/.
        </p>
        <template v-else>
          <p v-if="artState.error" class="art-error" data-testid="artifacts-error">{{ artState.error }}</p>
          <p
            v-else-if="artState.phase === 'loading' && !artState.artifacts.length"
            class="art-note"
          >Loading artifacts…</p>
          <p
            v-else-if="!artState.artifacts.length"
            class="art-note"
            data-testid="artifacts-empty"
          >No artifacts yet — <span class="mono">.acp/cards/{{ card.id.slice(0, 8) }}…</span> is empty or missing on the host.</p>

          <ul v-if="artState.artifacts.length" class="art-list" data-testid="artifacts-list">
            <li v-for="a in artState.artifacts" :key="a.name">
              <button
                class="art-row mono"
                :class="{ open: openArtifact?.name === a.name }"
                :title="a.path"
                @click="onOpenArtifact(a)"
              >
                <span class="art-name">{{ a.name }}</span>
                <span class="art-size">{{ a.mtime ? fmtStamp(a.mtime) + ' · ' : '' }}{{ fmtBytes(a.bytes) }}</span>
                <span v-if="a.token" class="art-tok" :class="`tok-${a.token.toLowerCase()}`">{{ a.token }}</span>
                <span v-if="a.error" class="art-tok tok-err" :title="a.error">error</span>
              </button>
            </li>
          </ul>

          <div v-if="checklistItems.length" class="check-block" data-testid="checklist">
            <div class="check-head">
              <span class="field-label">Plan checklist</span>
              <span
                class="check-progress mono"
                data-testid="checklist-progress"
                :title="`${checklistDone} of ${checklistItems.length} items marked done in ${CHECKLIST_FILE}`"
              >{{ checklistDone }}/{{ checklistItems.length }}</span>
            </div>
            <ul class="check-list" data-testid="checklist-items">
              <li
                v-for="(item, i) in checklistItems"
                :key="i"
                class="check-row mono"
                :class="{ done: item.done }"
              >
                <input
                  class="check-box"
                  type="checkbox"
                  :checked="item.done"
                  disabled
                  tabindex="-1"
                  :aria-label="item.text"
                />
                <span class="check-text">{{ item.text }}</span>
              </li>
            </ul>
          </div>

          <pre
            v-if="openArtifact"
            class="art-view mono"
            data-testid="artifact-view"
          >{{ openArtifact.error ? `${openArtifact.error}\n\n` : '' }}{{ openArtifact.content }}</pre>

          <div v-if="proposal.kind !== 'none'" class="art-proposal" data-testid="transition-proposal">
            <span class="art-proposal-label">{{ proposal.label }}</span>
            <button class="btn primary" data-testid="apply-transition" @click="onApplyTransition">Apply</button>
          </div>
          <p v-else-if="artState.phase === 'ready' && tokenArtifact" class="art-note" data-testid="transition-none">
            {{ proposal.label }}
          </p>
        </template>
      </div>

      <p class="drawer-stamps mono">
        created {{ fmtStamp(card.createdAt) }} · updated {{ fmtStamp(card.updatedAt) }}<template v-if="lastSavedAt"> · saved {{ fmtStamp(lastSavedAt) }}</template>
      </p>
    </div>

    <footer class="drawer-foot">
      <button
        v-if="attachedSession"
        class="btn primary"
        @click="onOpenSession"
      >Open session</button>
      <span v-else class="foot-spacer" />
      <button class="btn" @click="onDuplicate">Duplicate</button>
      <button class="btn danger" @click="onRemove">Delete</button>
      <button class="btn" @click="emit('close')">Done</button>
    </footer>
  </aside>
</template>

<style scoped>
.card-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(24rem, 94vw);
  display: flex;
  flex-direction: column;
  background: var(--bg-main, #fbf8f3);
  border-left: 1px solid var(--border-color, #e3dbcf);
  z-index: 40;
}

.drawer-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.drawer-title {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
}

.mono {
  font-family: var(--font-mono, monospace);
}

.drawer-id {
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.drawer-stage {
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.drawer-close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  cursor: pointer;
}

.drawer-close:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.625rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.field-label {
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.f-input {
  width: 100%;
  min-height: 28px;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-sidebar, #f6f2ec);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.8125rem;
}

textarea.f-input {
  resize: vertical;
  line-height: 1.4;
}

.f-input:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
  border-color: var(--text-accent, #c2532f);
}

.prio-seg {
  display: flex;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
}

.seg-btn {
  flex: 1;
  min-height: 28px;
  border: none;
  border-right: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
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
}

.seg-btn.flag-btn.active {
  color: var(--bg-danger, #b3402e);
}

.link-row {
  display: flex;
  gap: 0.375rem;
  margin-bottom: 0.375rem;
}

.link-label {
  flex: 0 0 34%;
}

.link-url {
  flex: 1;
}

.link-del {
  flex: 0 0 auto;
  width: 28px;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  font-size: 0.875rem;
  cursor: pointer;
}

.link-del:hover {
  color: var(--bg-danger, #b3402e);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.link-add {
  min-height: 26px;
  padding: 0 0.5rem;
  border: 1px dashed var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.link-add:hover {
  color: var(--text-accent, #c2532f);
  border-color: var(--text-accent, #c2532f);
}

.rel-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.25rem;
}

.rel-kind {
  flex: 0 0 5.5rem;
  font-size: 0.625rem;
  letter-spacing: 0.03em;
  color: var(--text-muted, #a39a8e);
}

.rel-chip {
  font-size: 0.625rem;
  padding: 0.0625rem 0.3rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-accent, #c2532f);
  cursor: pointer;
}

.rel-chip:hover {
  border-color: var(--text-accent, #c2532f);
}

.rel-chip.gone {
  color: var(--text-muted, #a39a8e);
  text-decoration: line-through;
}

.rel-pm {
  font-size: 0.625rem;
  padding: 0.0625rem 0.3rem;
  border-radius: var(--radius-sm, 4px);
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
  color: var(--text-accent, #c2532f);
}

.rel-note {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.drawer-stamps {
  margin: 0;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.drawer-foot {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.foot-spacer {
  flex: 1;
}

.drawer-foot .btn.primary {
  margin-right: auto;
}

.btn {
  min-height: 28px;
  padding: 0 0.625rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.btn:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.btn.primary {
  background: var(--bg-primary, #c2532f);
  border-color: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fbf8f3);
}

.btn.primary:hover {
  background: var(--bg-primary-hover, #a8431f);
}

.btn.danger {
  color: var(--bg-danger, #b3402e);
}

.btn:focus-visible,
.seg-btn:focus-visible,
.link-add:focus-visible,
.link-del:focus-visible,
.rel-chip:focus-visible,
.drawer-close:focus-visible,
.art-refresh:focus-visible,
.art-row:focus-visible {
  outline: 2px solid var(--accent-soft, rgba(194, 83, 47, 0.14));
  outline-offset: 1px;
}

/* Artifacts — the card-as-pipeline block. */

.artifacts {
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  padding-top: 0.625rem;
}

.art-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.art-refresh {
  margin-left: auto;
  min-height: 24px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.6875rem;
  cursor: pointer;
}

.art-refresh:hover {
  color: var(--text-accent, #c2532f);
  border-color: var(--text-accent, #c2532f);
}

.art-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.status-token {
  font-size: 0.625rem;
  letter-spacing: 0.02em;
  padding: 0.0625rem 0.3rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  color: var(--text-muted, #a39a8e);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.status-token.tok-approve,
.status-token.tok-done,
.art-tok.tok-approve,
.art-tok.tok-done {
  color: var(--bg-success, #5a7d4f);
  border-color: var(--bg-success, #5a7d4f);
}

.status-token.tok-changes_required,
.art-tok.tok-changes_required {
  color: var(--text-accent, #c2532f);
  border-color: var(--text-accent, #c2532f);
}

.status-token.tok-blocked,
.art-tok.tok-blocked,
.art-tok.tok-err {
  color: var(--bg-danger, #b3402e);
  border-color: var(--bg-danger, #b3402e);
}

.art-note {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--text-muted, #a39a8e);
}

/* Review findings: flat severity word + finding text + state, same row
   vocabulary as the artifact list (mono, muted, no buttons). */
.gate-note {
  color: var(--bg-danger, #b3402e);
}

.find-row {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
  padding: 0.125rem 0.375rem;
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--text-primary, #2b2723);
}

.find-row.find-closed,
.find-row.find-rejected {
  color: var(--text-muted, #a39a8e);
}

.find-sev {
  flex: 0 0 auto;
  padding: 0 0.25rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  font-size: 0.625rem;
}

.find-sev.sev-critical,
.find-sev.sev-major {
  color: var(--bg-danger, #b3402e);
  border-color: var(--bg-danger, #b3402e);
}

.find-sev.sev-minor,
.find-sev.sev-nit {
  color: var(--text-secondary, #6b6259);
}

.find-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.find-verd {
  flex: 0 0 auto;
  padding: 0 0.25rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  font-size: 0.625rem;
  white-space: nowrap;
}

.find-verd.verd-rejected {
  color: var(--bg-success, #5a7d4f);
  border-color: var(--bg-success, #5a7d4f);
}

.find-verd.verd-confirmed {
  color: var(--bg-danger, #b3402e);
  border-color: var(--bg-danger, #b3402e);
}

.find-verd.verd-disputed {
  color: var(--text-accent, #c2532f);
  border-color: var(--text-accent, #c2532f);
}

.find-st {
  flex: 0 0 auto;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
}

.art-error {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--bg-danger, #b3402e);
  overflow-wrap: anywhere;
}

.art-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.art-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 26px;
  padding: 0 0.375rem;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-primary, #2b2723);
  font-size: 0.6875rem;
  text-align: left;
  cursor: pointer;
}

.art-row:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.art-row.open {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.art-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.art-size {
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
}

.art-tok {
  padding: 0 0.25rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  font-size: 0.625rem;
  white-space: nowrap;
}

/* Plan checklist — read-only view of 03_checklist.md marks, same row
   vocabulary as the findings list (mono, flat, no buttons). */
.check-block {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.check-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.check-progress {
  font-size: 0.625rem;
  padding: 0.0625rem 0.3rem;
  border: 1px solid var(--border-color, #e3dbcf);
  border-radius: var(--radius-sm, 4px);
  color: var(--text-muted, #a39a8e);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.check-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.check-row {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
  padding: 0.125rem 0.375rem;
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--text-primary, #2b2723);
}

.check-box {
  flex: 0 0 auto;
  margin: 0;
  accent-color: var(--text-accent, #c2532f);
}

.check-box:disabled {
  cursor: default;
}

.check-row.done .check-text {
  color: var(--text-muted, #a39a8e);
  text-decoration: line-through;
}

.check-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.art-view {
  margin: 0;
  max-height: 16rem;
  overflow: auto;
  padding: 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-sidebar, #f6f2ec);
  font-size: 0.6875rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.art-proposal {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border: 1px dashed var(--border-color, #e3dbcf);
  border-radius: var(--radius-md, 6px);
}

.art-proposal-label {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
}

@media (max-width: 800px) {
  .art-refresh,
  .art-row,
  .art-proposal .btn {
    min-height: 44px;
  }
}

@media (max-width: 800px) {
  .card-drawer {
    width: 100%;
    border-left: none;
  }

  .btn,
  .seg-btn,
  .f-input,
  .link-add,
  .link-del {
    min-height: 44px;
  }

  .drawer-close {
    width: 44px;
    height: 44px;
  }
}
</style>
