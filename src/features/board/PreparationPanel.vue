<script setup lang="ts">
// Idea-preparation section of the card drawer (P5): the user-channel UI
// over the durable preparation session (server/execution/preparation/*).
// Everything rendered here comes from the execution store's polled
// preparation view — one durable discussion, derived readiness, pinned
// bindings — never from cached board state and never from a model's claim.
//
// Commands are deliberate user actions only: one click = one commandId =
// one POST through execStore.sendCommand (busy-guarded, revision-checked).
// Offline, every control is disabled with its reason; the server remains
// authoritative for every gate mirrored here.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import UiButton from '../../components/ui/UiButton.vue';
import { useBoardStore } from '../../stores/board';
import { useExecutionStore } from '../../stores/execution';
import {
  canChangePrepBinding,
  canConfirmGate,
  canPrepHandoff,
  canStartInMode,
  canStartPrep,
  canStopPrep,
  canTalkPrep,
  docKindLabel,
  fmtTs,
  prepAnswerPayload,
  prepBindingProblem,
  prepBindingsForStage,
  prepBlockerText,
  prepCompletenessState,
  prepContinuePayload,
  prepDraftPayload,
  prepGateLabel,
  prepGatePayload,
  prepHandoffPayload,
  prepOpenQuestionCounts,
  prepPhaseLabel,
  prepStageLabel,
  prepStartPayload,
  prepStatusLabel,
  prepStopPayload,
  prepBindPayload,
  PREP_DOWNSTREAM_MODES,
  PREP_STAGES,
  shortId,
  startableModes,
  type GateResult,
} from '../../lib/execution/ui-model';
import type {
  ExecDocKind,
  PrepBindingInfo,
  PrepGate,
  PrepQuestion,
  PrepStage,
} from '../../lib/execution/api';

const props = defineProps<{ cardId: string }>();

const emit = defineEmits<{ 'before-start': [] }>();
const board = useBoardStore();
const exec = useExecutionStore();

// This panel owns exactly one watch on its card — mounted with the drawer,
// re-balanced on a card switch (same contract as ExecutionPanel).
watch(
  () => props.cardId,
  (id, prev) => {
    if (prev && prev !== id) { exec.unwatchCard(prev); uiSeq += 1; startError.value = null; }
    if (id) exec.watchCard(id);
  },
);

onMounted(() => {
  exec.watchCard(props.cardId);
  void exec.loadPrepBindings();
});
onBeforeUnmount(() => {
  exec.unwatchCard(props.cardId);
  uiSeq += 1; // every in-flight answer/send for this card dies with the panel
});

const st = computed(() => exec.stateFor(props.cardId));
const view = computed(() => st.value.view);
const prep = computed(() => st.value.preparation);
const offline = computed(() => exec.online === false);
const busy = computed(() => st.value.busy !== null);

// The section renders only when the deployment advertises the feature AND
// the card is managed — an unmanaged card has no aggregate to hold a
// session, and a feature-off server has no endpoints.
const featureOn = computed(() => view.value?.features?.preparation === true);
const visible = computed(() => featureOn.value && view.value?.managed === true);

const session = computed(() => prep.value);
// The card view's summary is the cheap truth: while it names a session the
// full view hasn't delivered yet, render loading — never the start form
// (a transient blank would let a user start over a live session).
const loading = computed(
  () => featureOn.value && !session.value && !!view.value?.preparation,
);
const leadBlockerMessage = computed(() => {
  const blocker = session.value?.blocker;
  if (!blocker) return '';
  if (typeof blocker === 'string') return blocker;
  if (blocker.code === 'no_progress') return 'The discussion paused because the lead could not make progress. Your answers are saved. Send a message below to continue.';
  return blocker.detail || 'The lead could not continue. Your discussion is saved.';
});
const stopped = computed(() => session.value?.status === 'stopped');
const questions = computed(() => session.value?.checkpoint?.openQuestions ?? []);
const gatesAll = computed(() => session.value?.gates ?? []);
const lastAttempt = computed(() => {
  const list = session.value?.attempts ?? [];
  return list.length ? list[list.length - 1] : null;
});
const discussionEl = ref<HTMLElement | null>(null);
const focusSessionForCard = ref<string | null>(null);
watch(() => session.value?.sessionId, (id) => {
  if (id && focusSessionForCard.value === props.cardId) {
    focusSessionForCard.value = null;
    void showDiscussion();
  }
}, { flush: 'post' });
const openQuestionCount = computed(() => questions.value.filter(q => q.status === 'open').length);
const leadWorking = computed(() => session.value?.status === 'active' && lastAttempt.value?.status === 'running');
const firstTurn = computed(() => !questions.value.length && lastAttempt.value?.kind === 'kickoff');
const reviewEl = ref<HTMLElement | null>(null);
const ideaConfirmed = computed(() => gatesAll.value.some(g => g.type === 'intent_confirm' && g.status === 'confirmed'));
const needsIdeaReview = computed(() => !openQuestionCount.value && !!session.value?.intent.proposal && !ideaConfirmed.value);
const nextDraftKind = computed<ExecDocKind | null>(() => {
  if (!ideaConfirmed.value || openQuestionCount.value || leadWorking.value || session.value?.blocker) return null;
  if (!session.value?.presented.requirements) return 'requirements';
  if (prepCompletenessState(session.value, 'requirements') === 'approved' && !session.value?.presented.plan) return 'plan';
  return null;
});
const preparationNextStep = computed(() => {
  if (!ideaConfirmed.value || openQuestionCount.value) return '';
  if (session.value?.ready) return 'Requirements and plan are accepted. You can now explicitly hand off to development.';
  if (nextDraftKind.value === 'requirements') return 'Discussion complete. Your idea is confirmed. Next: create requirements from the recorded answers, then review and approve them.';
  if (nextDraftKind.value === 'plan') return 'Requirements are approved. Next: create the development plan, then review and approve it.';
  return 'Review the generated document in the card’s Documents section and approve its current version. Preparation is complete only after requirements and plan are accepted.';
});
const threadStatus = computed(() => {
  if (offline.value || st.value.prepError) return 'Connection interrupted. Your discussion is saved; reconnecting…';
  if (busy.value) return 'Saving your message…';
  if (leadWorking.value) return firstTurn.value
    ? 'The lead is reading your card and preparing the first question…'
    : 'Your answer is saved. The lead is preparing the next turn…';
  if (openQuestionCount.value) return 'The lead is waiting for your answer.';
  if (session.value?.ready) return 'Preparation is ready for handoff.';
  if (needsIdeaReview.value) return 'Discussion complete. Confirm the clarified idea below to proceed to requirements.';
  if (ideaConfirmed.value) return preparationNextStep.value;
  if (lastAttempt.value?.status === 'failed') return 'The lead could not finish this turn. Send a message to continue.';
  return 'The lead has finished this turn. Send a message to continue the discussion.';
});
async function showIdeaReview() {
  await nextTick();
  reviewEl.value?.scrollIntoView({ block: 'center', behavior: 'auto' });
}

async function showDiscussion() {
  await nextTick();
  discussionEl.value?.scrollIntoView({ block: 'start', behavior: 'auto' });
}
const handoffMode = ref('solo');
const handoffTargets = computed(() => session.value?.handoffTargets ?? []);
// Modes whose run backend the card view's `features` advertises — a
// handoff offer for a flagged mode names a real downstream target.
// The options render from `startableModes(view)` so the picker can never
// offer a start the server would refuse; the durability note below stays
// honest about what each mode means on this deployment.
const availableModes = computed(() =>
  view.value ? startableModes(view.value) : [...PREP_DOWNSTREAM_MODES],
);

let uiSeq = 0;
const stillCurrent = (cardId: string, seq: number) => props.cardId === cardId && seq === uiSeq;

function gated(gate: GateResult): { disabled: boolean; title: string } {
  if (offline.value) return { disabled: true, title: 'state server unreachable — actions are disabled' };
  if (starting.value) return { disabled: true, title: 'Saving the card before starting discussion…' };
  if (busy.value) return { disabled: true, title: `a ${st.value.busy} command is still in flight` };
  return { disabled: !gate.ok, title: gate.ok ? '' : gate.reason };
}

async function send(
  type: Parameters<typeof exec.sendCommand>[1],
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const cardId = props.cardId;
  const seq = uiSeq;
  const r = await exec.sendCommand(cardId, type, payload);
  if (!r.ok && r.error && stillCurrent(cardId, seq)) {
    alert(r.status === 409 ? `${r.error}\n\nState was reloaded from the server.` : r.error);
  }
  return stillCurrent(cardId, seq) ? r.ok : false;
}

// ---- start form -------------------------------------------------------------

const starting = ref(false);
const startError = ref<string | null>(null);
const card = computed(() => board.cards.find(c => c.id === props.cardId));
// '' = no binding for that stage at start (the lead runs unbound; the
// server still validates every selection it is given).
const startBindings = ref<Partial<Record<PrepStage, string>>>({});
const startBindingsOpen = ref(false);
const talkGate = computed(() => (view.value ? canTalkPrep(view.value) : { ok: false, reason: 'loading…' }));
const startGate = computed(() => {
  if (!view.value) return { ok: false, reason: 'loading…' };
  const g = canStartPrep(view.value);
  if (!g.ok) return g;
  if (!card.value?.title?.trim() && !card.value?.description?.trim()) return { ok: false, reason: 'Add the idea to the card title or description first' };
  return g;
});

async function onStartPrep() {
  if (starting.value || busy.value || offline.value) return;
  const cardId = props.cardId;
  const seq = uiSeq;
  starting.value = true;
  startError.value = null;
  try {
    emit('before-start');
    await board.persistManagedBoard();
    if (!stillCurrent(cardId, seq)) return;
    if (board.saveError) throw new Error(board.saveError.error);
    await exec.loadPrepBindings();
    if (!stillCurrent(cardId, seq)) return;
    const selected: Partial<Record<PrepStage, string | null>> = {};
    for (const stage of PREP_STAGES) {
      const binding = effectiveStartBinding(stage);
      if (binding) selected[stage] = binding;
    }
    focusSessionForCard.value = cardId;
    const ok = await send('start_preparation', prepStartPayload(undefined, selected));
    if (ok && stillCurrent(cardId, seq)) {
      startBindings.value = {};
      startBindingsOpen.value = false;
      if (session.value?.status === 'active') {
        focusSessionForCard.value = null;
        await showDiscussion();
      }
    } else if (focusSessionForCard.value === cardId) {
      focusSessionForCard.value = null;
    }
  } catch (e) {
    if (stillCurrent(cardId, seq)) startError.value = e instanceof Error ? e.message : String(e);
  } finally {
    starting.value = false;
  }
}

// ---- answers ----------------------------------------------------------------

const answerDrafts = ref<Record<string, string>>({});
const answerSelects = ref<Record<string, string>>({});

function questionGate(q: PrepQuestion): GateResult {
  const talk = talkGate.value;
  if (!talk.ok) return talk;
  if (q.status !== 'open') return { ok: false, reason: `question is ${q.status}` };
  const opts = q.dialog?.options;
  if (opts?.length) {
    if (!answerSelects.value[q.questionId]) return { ok: false, reason: 'choose an answer' };
    return { ok: true, reason: '' };
  }
  if (!(answerDrafts.value[q.questionId] ?? '').trim()) {
    return { ok: false, reason: 'type an answer' };
  }
  return { ok: true, reason: '' };
}

async function onAnswer(q: PrepQuestion) {
  const text = q.dialog?.options?.length
    ? answerSelects.value[q.questionId]
    : (answerDrafts.value[q.questionId] ?? '').trim();
  if (!text) return;
  const ok = await send('answer_question', prepAnswerPayload(q.questionId, text));
  if (ok) {
    delete answerDrafts.value[q.questionId];
    delete answerSelects.value[q.questionId];
  }
}

// ---- continue / stop ----------------------------------------------------------

const continueDraft = ref('');
const continueGate = computed(() => {
  if (!talkGate.value.ok) return talkGate.value;
  if (!continueDraft.value.trim()) return { ok: false, reason: 'write a message to the lead first' };
  return { ok: true, reason: '' };
});

async function onContinue() {
  const ok = await send('continue_discussion', prepContinuePayload(continueDraft.value));
  if (ok) continueDraft.value = '';
}

async function onStopPrep() {
  if (!confirm(
    'Stop this preparation session?\n\n' +
      'The discussion state is preserved (checkpoint, decisions, open ' +
      'questions stay recorded), but the conversation closes — the card ' +
      'returns to the plain managed lifecycle.',
  )) return;
  await send('stop_preparation', prepStopPayload());
}

// ---- drafts / documents ---------------------------------------------------------

const DOC_KINDS: ExecDocKind[] = ['requirements', 'design', 'plan'];
const draftGate = computed(() => talkGate.value);

function presentedLine(kind: ExecDocKind): string {
  const p = session.value?.presented?.[kind];
  if (!p) return '—';
  const bits = [shortId(p.versionId)];
  if (p.draft) bits.push('draft');
  // The server's completeness state is authoritative for staleness and
  // approval — the presented pointer alone cannot say whether a newer
  // version exists or the user approved this one.
  const state = prepCompletenessState(session.value, kind);
  if (state && state !== 'presented') bits.push(state);
  return bits.join(' · ');
}

/** Server-derived completeness line: kind states + discussion counters.
 * Rendered verbatim from the polled view — never a model claim. */
const completenessLine = computed(() => {
  const s = session.value;
  if (!s) return '';
  const kinds: ExecDocKind[] = ['requirements', 'design', 'plan'];
  const states = kinds.map((k) => `${k}: ${prepCompletenessState(s, k) ?? 'absent'}`);
  const q = prepOpenQuestionCounts(s);
  return `${states.join(' · ')} · questions open ${q.open} (blocking ${q.blocking}) · answered ${q.answered}`;
});

/** Handoff target picker: unimplemented modes stay selectable for the
 * durable offer, with the reason visible; starting a run in one is
 * refused by canStartInMode without a POST. */
const handoffModeStartGate = computed(() =>
  view.value ? canStartInMode(handoffMode.value, view.value) : { ok: false, reason: 'loading…' },
);

async function onRequestDraft(kind: ExecDocKind) {
  await send('request_draft', prepDraftPayload(kind));
}

// ---- gates ---------------------------------------------------------------------

async function onConfirmGate(g: PrepGate) {
  await send('confirm_gate', prepGatePayload(g.gateId));
}

// ---- bindings -------------------------------------------------------------------

const bindings = computed(() => exec.prepBindings ?? []);
const bindingsError = computed(() => exec.prepBindingsError);
function stageChoices(stage: PrepStage): PrepBindingInfo[] {
  return prepBindingsForStage(bindings.value, stage);
}
const recommendedBindings: Partial<Record<PrepStage, string>> = {
  intent: 'grill-me-intent', requirements: 'ce-brainstorm', plan: 'ce-plan', review: 'ce-doc-review',
};
function effectiveStartBinding(stage: PrepStage): string {
  if (startBindings.value[stage] !== undefined) return startBindings.value[stage] ?? '';
  const recommended = recommendedBindings[stage];
  return stageChoices(stage).some(b => b.bindingId === recommended && b.status === 'available') ? recommended! : '';
}
const bindPicks = ref<Partial<Record<PrepStage, string>>>({});

function stageProblem(stage: PrepStage): string | null {
  return prepBindingProblem(session.value?.bindings?.[stage] ?? null);
}

async function onApplyBinding(stage: PrepStage) {
  const want = bindPicks.value[stage] ?? '';
  const bindingId = want === '' ? null : want;
  await send('change_skill_binding', prepBindPayload(stage, bindingId));
  void exec.loadPrepBindings(true);
}

// ---- handoff --------------------------------------------------------------------

const handoffGate = computed(() =>
  view.value ? canPrepHandoff(view.value) : { ok: false, reason: 'loading…' });

async function onHandoff() {
  const mode = handoffMode.value;
  const target = handoffTargets.value.find((t) => t.mode === mode);
  if (!confirm(
    `Record a handoff offer for mode "${mode}"?\n\n` +
      'This freezes the current accepted inputs into a durable handoff ' +
      'record. It does NOT start implementation — that stays a separate ' +
      'Start action below.' +
      (target && !target.implemented
        ? `\n\nNote: mode "${mode}" is not implemented on this deployment — ` +
          'the offer is recorded as unimplemented.' : ''),
  )) return;
  await send('handoff_preparation', prepHandoffPayload(mode));
}

const gateStatusClass = (g: PrepGate) => `prep-gate-${g.status}`;
</script>

<template>
  <section v-if="visible" class="exec-panel prep-panel" data-testid="prep-panel">
    <div class="exec-block">
      <div class="exec-blockhead">
        <span class="exec-blocktitle">Idea preparation</span>
        <span
          v-if="session"
          class="exec-line mono"
          data-testid="prep-status"
        >{{ prepStatusLabel(session.status) }} · {{ prepPhaseLabel(session.phase) }}<template v-if="session.ready"> · ready</template></span>
      </div>
      <p v-if="st.prepError" class="exec-line exec-warn" data-testid="prep-stale">
        last known state — the preparation view failed to refresh: {{ st.prepError }}
      </p>
      <p v-if="st.commandError" class="exec-line exec-warn" data-testid="prep-cmderror">
        {{ st.commandError.error }}
      </p>

      <!-- ── session view in flight ─────────────────────────────────────── -->
      <p v-if="loading" class="exec-line" data-testid="prep-loading">
        loading the preparation session…
      </p>

      <!-- ── no session: the start form ─────────────────────────────────── -->
      <template v-else-if="!session">
        <p class="ui-note" data-testid="prep-card-source">
          We'll use this card's title and description. The lead will challenge assumptions,
          explore alternatives and ask focused questions, then turn your answers into requirements and a plan.
        </p>
        <p v-if="startError" class="exec-line exec-warn" data-testid="prep-start-error">{{ startError }}</p>
        <details
          class="prep-bindings-detail"
          data-testid="prep-bindings-start"
          :open="startBindingsOpen"
          @toggle="startBindingsOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary class="exec-line">Advanced: discussion skills</summary>
          <div v-for="stage in PREP_STAGES" :key="`start-${stage}`" class="prep-bindrow">
            <span class="exec-role">{{ prepStageLabel(stage) }}</span>
            <select
              :value="effectiveStartBinding(stage)"
              @change="startBindings[stage] = ($event.target as HTMLSelectElement).value"
              class="f-input ui-input exec-select exec-grow"
              :data-testid="`prep-start-bind-${stage}`"
            >
              <option value="">lead only (no skill)</option>
              <option
                v-for="b in stageChoices(stage).filter(b => b.status === 'available')"
                :key="b.bindingId"
                :value="b.bindingId"
                :disabled="b.status !== 'available'"
              >{{ b.bindingId }}{{ b.status !== 'available' ? ` — unavailable: ${b.unsupported?.reason ?? b.status}` : '' }}</option>
            </select>
          </div>
          <p v-if="bindingsError" class="exec-line exec-warn" data-testid="prep-bindings-error">
            binding registry: {{ bindingsError }}
          </p>
        </details>
        <div class="exec-btnrow">
          <UiButton
            class="exec-btn"
            variant="primary"
            data-testid="prep-start"
            :disabled="gated(startGate).disabled"
            :title="gated(startGate).title"
            @click="onStartPrep"
          >{{ starting ? 'Saving card…' : 'Start brainstorming' }}</UiButton>
        </div>
      </template>

      <!-- ── stopped session ────────────────────────────────────────────── -->
      <template v-else-if="stopped">
        <p class="exec-line" data-testid="prep-stopped">
          Session {{ session.sessionId }} stopped{{ session.stopReason ? ` — ${session.stopReason}` : '' }}.
          The checkpoint, documents and open questions are preserved; starting
          again creates a new session.
        </p>
        <div class="exec-startrow">
          <p class="ui-note">A new discussion starts from the current card.</p>
          <UiButton
            class="exec-actionbtn"
            variant="primary"
            data-testid="prep-restart"
            :disabled="gated(startGate).disabled"
            :title="gated(startGate).title"
            @click="onStartPrep"
          >Start new session</UiButton>
        </div>
      </template>

      <!-- ── the live session ───────────────────────────────────────────── -->
      <template v-else-if="session">
        <div v-if="leadWorking || openQuestionCount" class="prep-turn-status" role="status" aria-live="polite" :aria-busy="leadWorking">
          <span v-if="leadWorking" data-testid="prep-lead-waiting">
            <span class="prep-spinner" aria-hidden="true"></span>
            {{ firstTurn ? 'The lead is reading your card and preparing the first question…' : 'The lead is considering your answer and preparing the next turn…' }}
          </span>
          <template v-else>
            <span>The lead is waiting for your answer.</span>
            <UiButton size="xs" data-testid="prep-discussion-jump" @click="showDiscussion">Answer the lead</UiButton>
          </template>
        </div>
        <p v-if="typeof lastAttempt?.progress === 'string' && lastAttempt.progress" class="exec-line" data-testid="prep-progress">
          {{ lastAttempt.progress }}
        </p>

        <!-- one durable discussion -->
        <div ref="discussionEl" class="prep-discussion prep-section ui-surface" data-testid="prep-discussion">
          <div class="exec-subtitle">Discussion</div>
          <div v-if="!questions.length && !leadWorking" class="exec-line" data-testid="prep-no-questions">
            No questions recorded yet. Check the lead status above.
          </div>
          <div
            v-for="q in questions"
            :key="q.questionId"
            class="prep-q"
            :class="{ 'prep-q-open': q.status === 'open' }"
            :data-testid="`prep-q-${q.questionId}`"
          >
            <p class="exec-sumtext" :data-testid="`prep-qtext-${q.questionId}`">
              <span class="exec-role" data-testid="prep-qchip">Q</span>
              {{ q.text }}
            </p>
            <p v-if="q.status === 'answered'" class="exec-line prep-answer" :data-testid="`prep-a-${q.questionId}`">
              → {{ q.answer }}
            </p>
            <p v-else-if="q.status !== 'open'" class="exec-line">
              → {{ q.status }}
            </p>
            <div v-else class="prep-answerrow">
              <select
                v-if="q.dialog?.options?.length"
                v-model="answerSelects[q.questionId]"
                class="f-input ui-input exec-select exec-grow"
                :data-testid="`prep-answer-select-${q.questionId}`"
              >
                <option value="" disabled>choose…</option>
                <option v-for="o in q.dialog!.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input
                v-else
                v-model="answerDrafts[q.questionId]"
                class="f-input ui-input exec-grow"
                :data-testid="`prep-answer-${q.questionId}`"
                placeholder="your answer…"
                @keydown.enter="onAnswer(q)"
              />
              <UiButton
                class="exec-actionbtn"
                :data-testid="`prep-send-${q.questionId}`"
                :disabled="gated(questionGate(q)).disabled"
                :title="gated(questionGate(q)).title"
                @click="onAnswer(q)"
              >Answer</UiButton>
            </div>
          </div>
          <div class="prep-thread-state" role="status" aria-live="polite" :aria-busy="busy || leadWorking" data-testid="prep-thread-state">
            <p v-if="session.blocker" class="exec-line exec-warn" data-testid="prep-blocker">{{ leadBlockerMessage }}</p>
            <template v-else>
              <span v-if="busy || leadWorking" class="prep-spinner" aria-hidden="true"></span>
              <span data-testid="prep-thread-status">{{ threadStatus }}</span>
              <UiButton v-if="needsIdeaReview && !busy && !leadWorking" size="xs" data-testid="prep-review-jump" @click="showIdeaReview">Review idea</UiButton>
            </template>
          </div>
          <div class="exec-startrow">
            <input
              v-model="continueDraft"
              class="f-input ui-input exec-grow"
              data-testid="prep-continue-text"
              placeholder="say something to the lead — steer, correct, add context…"
              @keydown.enter="onContinue"
            />
            <UiButton
              class="exec-actionbtn"
              data-testid="prep-continue"
              :disabled="gated(continueGate).disabled"
              :title="gated(continueGate).title"
              @click="onContinue"
            >Send</UiButton>
          </div>
        </div>

          <div v-if="session.checkpoint.decisions.length" class="exec-detail prep-section ui-surface" data-testid="prep-decisions">
            <div class="exec-subtitle">Decisions</div>
            <p v-for="(d, i) in session.checkpoint.decisions" :key="`d-${i}`" class="exec-line">
              · {{ d.text }}
            </p>
          </div>
          <div v-if="session.checkpoint.assumptions.length" class="exec-detail prep-section ui-surface" data-testid="prep-assumptions">
            <div class="exec-subtitle">Assumptions</div>
            <p v-for="(a, i) in session.checkpoint.assumptions" :key="`a-${i}`" class="exec-line">
              ~ {{ a.text }}
            </p>
          </div>

        <div v-if="ideaConfirmed && !openQuestionCount && !leadWorking" class="exec-detail prep-section ui-surface ui-surface-accent" data-testid="prep-next-step">
          <div class="exec-subtitle">Next step</div>
          <p class="ui-note">{{ preparationNextStep }}</p>
          <UiButton v-if="nextDraftKind" variant="primary" data-testid="prep-next-draft"
            :disabled="gated(draftGate).disabled" :title="gated(draftGate).title"
            @click="onRequestDraft(nextDraftKind)">{{ nextDraftKind === 'requirements' ? 'Create requirements' : 'Create development plan' }}</UiButton>
          <p class="ui-note">Implementation starts only after an explicit handoff and launch.</p>
        </div>
        <div ref="reviewEl" v-if="needsIdeaReview" class="exec-detail prep-section ui-surface ui-surface-accent" data-testid="prep-intent-review">
          <div class="exec-subtitle">Review the clarified idea</div>
          <p class="exec-sumtext">{{ session.intent.proposal?.text }}</p>
          <UiButton v-for="g in gatesAll.filter(g => g.type === 'intent_confirm' && g.status === 'pending')"
            :key="g.gateId" :disabled="gated(canConfirmGate(view!, g)).disabled"
            @click="onConfirmGate(g)">Confirm idea</UiButton>
        </div>
        <div v-if="DOC_KINDS.some(k => !!session?.presented[k])" class="exec-detail prep-section ui-surface" data-testid="prep-document-review">
          <div class="exec-subtitle">Documents for review</div>
          <p v-for="k in DOC_KINDS.filter(k => !!session?.presented[k])" :key="k" class="exec-line">
            {{ docKindLabel(k) }} · {{ presentedLine(k) }}
          </p>
          <UiButton v-for="g in gatesAll.filter(g => g.type !== 'intent_confirm' && g.status === 'pending' && !!g.subject)"
            :key="g.gateId" :disabled="gated(canConfirmGate(view!, g)).disabled"
            @click="onConfirmGate(g)">{{ prepGateLabel(g) }}</UiButton>
        </div>
        <!-- handoff — records the offer; implementation start stays a
             separate action in the run section below -->
        <div v-if="session.ready" class="exec-detail" data-testid="prep-handoff">
          <div class="exec-subtitle">Handoff</div>
          <div class="exec-actionrow">
            <select v-model="handoffMode" class="f-input ui-input exec-select" data-testid="prep-handoff-mode">
              <option
                v-for="t in handoffTargets"
                :key="t.mode"
                :value="t.mode"
              >{{ t.mode }}{{ t.implemented ? '' : ' (not implemented)' }}</option>
            </select>
            <UiButton
              class="exec-actionbtn"
              data-testid="prep-handoff-btn"
              :disabled="gated(handoffGate).disabled"
              :title="gated(handoffGate).title"
              @click="onHandoff"
            >Record handoff offer</UiButton>
          </div>
          <p class="exec-line mono" data-testid="prep-modes-available">
            startable on this deployment: {{ availableModes.join(', ') || '—' }}
          </p>
          <div v-for="h in session.handoffs" :key="h.handoffId" class="exec-line" :data-testid="`prep-handoff-${h.handoffId}`">
            → {{ h.mode }} @ {{ fmtTs(h.at) }}{{ h.stale ? ' — stale (inputs changed)' : '' }}{{ h.implemented === false ? ' — mode not implemented' : '' }}
          </div>
          <p v-if="!handoffModeStartGate.ok" class="exec-line exec-warn" data-testid="prep-handoff-start-note">
            {{ handoffModeStartGate.reason }}
          </p>
        </div>

        <details class="prep-bindings-detail" data-testid="prep-diagnostics">
          <summary class="exec-line">Diagnostics</summary>
          <pre v-if="session.blocker" class="exec-line prep-blocker-detail">{{ session.blocker }}</pre>
        <details class="prep-bindings-detail prep-controls" data-testid="prep-controls">
          <summary class="exec-line">Advanced controls</summary>
        <!-- documents + drafts -->
        <div class="exec-detail" data-testid="prep-docs">
          <div class="exec-subtitle">Documents</div>
          <p class="exec-line mono" data-testid="prep-completeness">{{ completenessLine }}</p>
          <div v-for="k in DOC_KINDS" :key="k" class="exec-actionrow">
            <span class="exec-role">{{ docKindLabel(k) }}</span>
            <span class="exec-line exec-grow mono" :data-testid="`prep-doc-${k}`">{{ presentedLine(k) }}</span>
            <UiButton
              class="exec-actionbtn"
              :data-testid="`prep-draft-${k}`"
              :disabled="gated(draftGate).disabled"
              :title="gated(draftGate).title"
              @click="onRequestDraft(k)"
            >Draft {{ k }}</UiButton>
          </div>
        </div>

        <!-- gates -->
        <div v-if="gatesAll.length" class="exec-detail" data-testid="prep-gates">
          <div class="exec-subtitle">Skill gates</div>
          <div
            v-for="g in gatesAll"
            :key="g.gateId"
            class="exec-actionrow"
            :data-testid="`prep-gate-${g.gateId}`"
          >
            <span class="exec-line exec-grow" :class="gateStatusClass(g)">
              {{ prepGateLabel(g) }}<template v-if="g.status !== 'pending'"> — {{ g.status }}<template v-if="g.invalidationReason"> ({{ g.invalidationReason }})</template></template>
            </span>
            <UiButton
              v-if="g.status === 'pending'"
              class="exec-actionbtn"
              :data-testid="`prep-gate-confirm-${g.gateId}`"
              :disabled="gated(canConfirmGate(view!, g)).disabled"
              :title="gated(canConfirmGate(view!, g)).title"
              @click="onConfirmGate(g)"
            >Confirm</UiButton>
          </div>
        </div>

        <!-- bindings -->
        <div class="exec-detail" data-testid="prep-bindings">
          <div class="exec-subtitle">Skill bindings</div>
          <div v-for="stage in PREP_STAGES" :key="stage" class="exec-detail">
            <div class="exec-actionrow">
              <span class="exec-role">{{ prepStageLabel(stage) }}</span>
              <select
                v-model="bindPicks[stage]"
                class="f-input ui-input exec-select exec-grow"
                :data-testid="`prep-bind-${stage}`"
              >
                <option value="">{{ session.bindings[stage]?.bindingId ?? 'lead only' }}</option>
                <option
                  v-for="b in stageChoices(stage)"
                  :key="b.bindingId"
                  :value="b.bindingId"
                  :disabled="b.status !== 'available'"
                >{{ b.bindingId }}{{ b.status !== 'available' ? ` — unavailable: ${b.unsupported?.reason ?? b.status}` : '' }}</option>
              </select>
              <UiButton
                class="exec-actionbtn"
                :data-testid="`prep-bind-apply-${stage}`"
                :disabled="gated(canChangePrepBinding(view!, stage, bindPicks[stage] || null)).disabled"
                :title="gated(canChangePrepBinding(view!, stage, bindPicks[stage] || null)).title"
                @click="onApplyBinding(stage)"
              >Set</UiButton>
            </div>
            <p v-if="stageProblem(stage)" class="exec-line exec-warn" :data-testid="`prep-bind-problem-${stage}`">
              {{ stageProblem(stage) }}
            </p>
          </div>
          <p v-if="bindingsError" class="exec-line exec-warn" data-testid="prep-bindings-error">
            binding registry: {{ bindingsError }}
          </p>
        </div>

        </details>

        <p class="exec-line mono" data-testid="prep-meta">
          {{ session.sessionId }} · discussion “{{ session.discussion ?? 'prep' }}” · updated {{ fmtTs(session.updatedAt) }}
        </p>
        <!-- readiness blockers — named, never a confidence number -->
        <ul v-if="session.blockers.length" class="exec-checks" data-testid="prep-blockers">
          <li
            v-for="(b, i) in session.blockers"
            :key="i"
            class="exec-checkline exec-blocking"
            data-testid="prep-blocker-item"
          >{{ prepBlockerText(b) }}</li>
        </ul>
        <p v-else class="exec-line" data-testid="prep-ready">ready — all approvals and gates hold</p>

        </details>

        <div class="exec-btnrow">
          <UiButton
            class="exec-btn"
            variant="danger"
            data-testid="prep-stop"
            :disabled="gated(canStopPrep(view!)).disabled"
            :title="gated(canStopPrep(view!)).title"
            @click="onStopPrep"
          >Stop preparation</UiButton>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.prep-panel {
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  padding-top: 0.625rem;
}
.exec-block {
  margin-top: 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-sm, 4px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.02));
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.exec-blockhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.exec-blocktitle {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-secondary, #6b6259);
}
.exec-line {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
  margin: 0;
}
.exec-subtitle {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--text-secondary, #6b6259);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.exec-btnrow,
.exec-actionrow {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
  align-items: center;
}
.exec-btn {
  align-self: flex-start;
}
.exec-warn,
.exec-blocking {
  color: var(--text-accent, #c2532f);
}
.exec-detail {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.exec-role {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-checks {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.exec-checkline {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-grow {
  flex: 1;
  min-width: 0;
}
.exec-startrow {
  display: flex;
  gap: 0.375rem;
  align-items: center;
}
.exec-actionbtn {
  flex: none;
}
.exec-sumtext {
  margin: 0;
  font-size: 0.625rem;
  color: var(--text-primary, #2b2723);
  white-space: pre-wrap;
}
.prep-thread-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 0.75rem;
}
.prep-thread-state > [data-testid="prep-thread-status"] { flex: 1; min-width: 0; }
.prep-thread-state + .exec-startrow { border-top: 0; padding-top: 0; }
.prep-blocker-detail { white-space: pre-wrap; overflow-wrap: anywhere; }
.prep-section {
  margin-top: 0.375rem;
  gap: 0.5rem;
  overflow-wrap: anywhere;
}
.prep-discussion {
  display: flex;
  flex-direction: column;
}
.prep-discussion > .exec-startrow {
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-color);
}
.prep-answer {
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--bg-user);
  color: var(--text-primary);
}
.prep-q {
  border-left: 2px solid var(--border-faint, rgba(43, 39, 35, 0.15));
  padding-left: 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding-top: 0.375rem;
  padding-bottom: 0.375rem;
}
.prep-q-open {
  border-left-color: var(--text-accent, #c2532f);
}
.prep-answerrow {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.prep-bindrow {
  display: grid;
  grid-template-columns: 4.5rem 1fr;
  gap: 0.25rem;
  align-items: center;
  margin-top: 0.25rem;
}
.prep-bindings-detail summary {
  cursor: pointer;
}
.prep-controls > .exec-detail {
  margin-top: 0.625rem;
}
.prep-gate-confirmed {
  color: var(--text-secondary, #6b6259);
}
.prep-gate-invalidated {
  color: var(--text-accent, #c2532f);
  text-decoration: line-through;
}
.prep-turn-status {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--border-faint);
  border-radius: 6px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.75rem;
}
.prep-spinner {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  margin-right: 0.25rem;
  border: 2px solid var(--border-faint);
  border-top-color: var(--text-accent);
  border-radius: 50%;
  animation: prep-spin 1s linear infinite;
}
@keyframes prep-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .prep-spinner { animation: none; } }
</style>
