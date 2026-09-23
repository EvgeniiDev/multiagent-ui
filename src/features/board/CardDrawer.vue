<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import {
  useBoardStore,
  type BoardCard,
  type BoardStageId,
  type CardStatus,
} from '../../stores/board';
import { useSessionStore } from '../../stores/session';
import { useConfigStore } from '../../stores/config';
import { useProjectsStore } from '../../stores/projects';
import { projectName } from '../../stores/activity';
import {
  useArtifactsStore,
  pickStatusArtifact,
  proposeTransition,
  parseStatusToken,
  reviewRoundOf,
  type CardArtifact,
} from '../../stores/artifacts';
import { BOARD_STAGES, PRIORITIES, statusesForStage, stageLabel } from './columns';
import { fmtStamp } from './format';

const props = defineProps<{
  cardId: string;
}>();

const emit = defineEmits<{
  close: [];
  'open-session': [session: { agentName: string; sessionId: string }];
}>();

const board = useBoardStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const projectsStore = useProjectsStore();
const artifactsStore = useArtifactsStore();

const card = computed(() => board.cards.find((c) => c.id === props.cardId) ?? null);

// Local draft, debounced back into the store. Edits are never lost to a
// misclick outside the drawer — there is no cancel path by design.
interface Draft {
  title: string;
  description: string;
  project: string;
  agent: string;
  priority: 'high' | 'medium' | 'low';
  acceptance: string;
  verification: string;
  blocked: boolean;
  blockedReason: string;
  cancelled: boolean;
  stage: BoardStageId;
  status: CardStatus | null;
  links: { label: string; url: string }[];
  sessionKey: string;
}

const draft = ref<Draft>({
  title: '',
  description: '',
  project: '',
  agent: '',
  priority: 'medium',
  acceptance: '',
  verification: '',
  blocked: false,
  blockedReason: '',
  cancelled: false,
  stage: 'backlog',
  status: null,
  links: [],
  sessionKey: '',
});

const lastSavedAt = ref<number | null>(null);
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function draftFromCard(c: BoardCard): Draft {
  return {
    title: c.title,
    description: c.description,
    project: c.project,
    agent: c.agent,
    priority: c.priority,
    acceptance: c.acceptance,
    verification: c.verification,
    blocked: c.blocked,
    blockedReason: c.blockedReason,
    cancelled: c.cancelled,
    stage: c.stage,
    status: c.status,
    links: c.links.map((l) => ({ ...l })),
    sessionKey: c.session ? `${c.session.agentName}::${c.session.sessionId}` : '',
  };
}

watch(
  () => props.cardId,
  () => {
    if (card.value) draft.value = draftFromCard(card.value);
  },
  { immediate: true }
);

function markDirty() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

function flush() {
  saveTimer = null;
  const c = card.value;
  if (!c) return;
  const d = draft.value;
  // Stage first (a stage change may reset the status), then the in-stage
  // status, then the flags — each through its own mutation so the stage's
  // status rules and the ledger entries stay intact.
  if (d.stage !== c.stage) {
    board.moveCard(c.id, d.stage);
  }
  if (d.status && d.status !== c.status) {
    board.setCardStatus(c.id, d.status);
  }
  if (d.blocked !== c.blocked) board.setCardFlag(c.id, 'blocked', d.blocked);
  if (d.cancelled !== c.cancelled) board.setCardFlag(c.id, 'cancelled', d.cancelled);
  const sessionKey = d.sessionKey;
  const session = sessionKey
    ? { agentName: sessionKey.split('::')[0], sessionId: sessionKey.split('::').slice(1).join('::') }
    : null;
  board.updateCard(c.id, {
    title: d.title.trim() || 'Untitled card',
    description: d.description,
    project: d.project.trim(),
    agent: d.agent,
    priority: d.priority,
    acceptance: d.acceptance,
    verification: d.verification,
    blockedReason: d.blockedReason.trim(),
    links: d.links
      .filter((l) => l.label.trim() || l.url.trim())
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    session,
  });
  lastSavedAt.value = Date.now();
}

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

function onStagePicked() {
  // Keep the draft's status if it exists in the new stage, else reset to
  // the stage's initial (null for backlog/done).
  const allowed = statusesForStage(draft.value.stage);
  if (!draft.value.status || !allowed.includes(draft.value.status)) {
    draft.value.status = allowed[0] ?? null;
  }
  markDirty();
}

function onSessionPicked() {
  // When a session is attached and the project is still empty, default the
  // project to the session's cwd last segment (spec: project defaults to
  // the last path segment).
  if (!draft.value.project.trim() && attachedSession.value?.cwd) {
    draft.value.project = projectName(attachedSession.value.cwd);
  }
  markDirty();
}

function addLink() {
  draft.value.links.push({ label: '', url: '' });
}

function removeLink(i: number) {
  draft.value.links.splice(i, 1);
  markDirty();
}

function onDuplicate() {
  flush();
  const copy = board.duplicateCard(props.cardId);
  if (copy) emit('close');
}

function onRemove() {
  const c = card.value;
  if (!c) return;
  if (confirm(`Delete "${c.title || 'Untitled card'}"?`)) {
    board.removeCard(c.id);
    emit('close');
  }
}

function onOpenSession() {
  const s = attachedSession.value;
  if (s) emit('open-session', { agentName: s.agentName, sessionId: s.sessionId });
}

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
  if (p.kind === 'move') board.moveCard(c.id, p.to);
  else if (p.kind === 'status') board.setCardStatus(c.id, p.status);
  else {
    board.setCardFlag(c.id, 'blocked', true);
    if (p.reason) board.updateCard(c.id, { blockedReason: p.reason });
  }
  if (card.value) draft.value = draftFromCard(card.value);
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
  if (saveTimer) {
    clearTimeout(saveTimer);
    flush();
  }
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
          placeholder="Card title" @input="markDirty" />
      </label>

      <label class="field">
        <span class="field-label">Description</span>
        <textarea v-model="draft.description" data-field="description" class="f-input" rows="3"
          placeholder="What needs doing" @input="markDirty" />
      </label>

      <div class="field-row">
        <label class="field">
          <span class="field-label">Project</span>
          <input v-model="draft.project" data-field="project" class="f-input mono" type="text"
            list="board-project-list" placeholder="project" @input="markDirty" />
          <datalist id="board-project-list">
            <option v-for="p in board.projectOptions" :key="p" :value="p" />
          </datalist>
        </label>

        <label class="field">
          <span class="field-label">Agent</span>
          <select v-model="draft.agent" data-field="agent" class="f-input" @change="markDirty">
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
            @click="draft.priority = p.id; markDirty()"
          >{{ p.label }}</button>
        </div>
      </div>

      <div class="field-row">
        <label class="field">
          <span class="field-label">Stage</span>
          <select v-model="draft.stage" data-field="stage" class="f-input" @change="onStagePicked">
            <option v-for="c in BOARD_STAGES" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Status</span>
          <select v-model="draft.status" data-field="status" class="f-input"
            :disabled="!statusesForStage(draft.stage).length" @change="markDirty">
            <option v-if="!statusesForStage(draft.stage).length" :value="null">—</option>
            <option v-for="s in statusesForStage(draft.stage)" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </div>

      <div class="field">
        <span class="field-label">Flags</span>
        <div class="prio-seg" role="group" aria-label="Card flags">
          <button
            class="seg-btn flag-btn"
            :class="{ active: draft.blocked }"
            :aria-pressed="draft.blocked"
            data-field="blocked"
            @click="draft.blocked = !draft.blocked; markDirty()"
          >blocked</button>
          <button
            class="seg-btn flag-btn"
            :class="{ active: draft.cancelled }"
            :aria-pressed="draft.cancelled"
            data-field="cancelled"
            @click="draft.cancelled = !draft.cancelled; markDirty()"
          >cancelled</button>
        </div>
      </div>

      <label v-if="draft.blocked" class="field">
        <span class="field-label">Blocked reason</span>
        <input v-model="draft.blockedReason" data-field="blockedReason" class="f-input" type="text"
          placeholder="what blocks it (optional card ref)" @input="markDirty" />
      </label>

      <label class="field">
        <span class="field-label">Acceptance criteria</span>
        <textarea v-model="draft.acceptance" data-field="acceptance" class="f-input" rows="4"
          placeholder="One per line" @input="markDirty" />
      </label>

      <label class="field">
        <span class="field-label">Verification steps</span>
        <textarea v-model="draft.verification" data-field="verification" class="f-input" rows="4"
          placeholder="How to prove it works" @input="markDirty" />
      </label>

      <div class="field">
        <span class="field-label">Links</span>
        <div v-for="(link, i) in draft.links" :key="i" class="link-row">
          <input v-model="link.label" class="f-input link-label" type="text" placeholder="label"
            aria-label="Link label" @input="markDirty" />
          <input v-model="link.url" class="f-input mono link-url" type="text" placeholder="https://…"
            aria-label="Link URL" @input="markDirty" />
          <button class="link-del" aria-label="Remove link" @click="removeLink(i)">×</button>
        </div>
        <button class="link-add" @click="addLink">+ Add link</button>
      </div>

      <label class="field">
        <span class="field-label">Attached session</span>
        <select v-model="draft.sessionKey" data-field="session" class="f-input" @change="onSessionPicked">
          <option value="">None</option>
          <option
            v-for="s in sessionOptions"
            :key="`${s.agentName}::${s.sessionId}`"
            :value="`${s.agentName}::${s.sessionId}`"
          >{{ s.agentName }} · {{ s.title }}</option>
        </select>
      </label>

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
