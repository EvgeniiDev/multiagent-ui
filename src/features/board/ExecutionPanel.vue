<script setup lang="ts">
// Managed execution section of the card drawer (U6): the user-channel UI
// over the execution state service. Everything rendered here comes from
// the execution store's polled card view — never from cached board state.
//
// Lifecycle commands are deliberate user actions only: one click = one
// commandId = one POST through execStore.sendCommand (busy-guarded).
// Nothing is queued offline — while the state server is unreachable every
// action is disabled with its reason visible.
//
// Every async callback here carries an owner+generation guard: a document
// fetch/artifact read/command issued for card A (or version V) can never
// land on card B's editor or overwrite typing the user started meanwhile.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useBoardStore } from '../../stores/board';
import { useExecutionStore } from '../../stores/execution';
import {
  acceptPayload,
  attachDocPayload,
  approveWorkOrderPayload,
  canAccept,
  canApproveWorkOrder,
  canContinue,
  canExcludePanelist,
  canOrchAnswer,
  canOrchApprove,
  canOrchGrant,
  canOrchRetry,
  canRetryParticipant,
  canStart,
  canStartFusion,
  canStartOrchestrator,
  canStartSwarm,
  canStop,
  canSwarmDecide,
  canSwarmExtend,
  canSwarmInput,
  checksToRows,
  currentVersion,
  currentWorkOrder,
  docKindLabel,
  docState,
  effectivePlanChecks,
  enableEligibility,
  excludePanelistPayload,
  fmtSha,
  fmtTs,
  fusion as fusionState,
  fusionDraftProblems,
  fusionParticipants,
  fusionPendingActions,
  fusionStartPayload,
  fusionStatusLabel,
  fusionWorkOrders,
  isFusion,
  isOrchestrator,
  isSwarm,
  orchAnswerPayload,
  orchApprovePayload,
  orchDraftProblems,
  orchGrantPayload,
  orchestrator as orchState,
  orchPendingActions,
  orchPendingActionText,
  orchPhaseLabel,
  orchRetryPayload,
  orchStartPayload,
  orchTaskStatusLabel,
  orchTasks,
  participantStatusLabel,
  phaseLabel,
  planBindingNote,
  pendingActionText,
  presetCommandPayload,
  reservedRuns,
  resultKindLabel,
  retryParticipantPayload,
  rowsToChecks,
  runStatusLabel,
  shortId,
  startPayload,
  stopPayload,
  continuePayload,
  swarm as swarmState,
  swarmDecidePayload,
  swarmDecisions,
  swarmDraftProblems,
  swarmExtendPayload,
  swarmFrozen,
  swarmInputPayload,
  swarmMessages,
  swarmParticipants,
  swarmPendingActions,
  swarmPendingActionText,
  swarmPhaseLabel,
  swarmStartPayload,
  swarmStatusLabel,
  verdictLabel,
  type CheckRow,
  type DocSourceInput,
  type FusionDraft,
  type OrchDraft,
  type SwarmDraft,
} from '../../lib/execution/ui-model';
import type { ExecCheck, ExecDocKind, ExecPresetInput, ExecRole, FusionWorkOrder } from '../../lib/execution/api';
import ManagedRunEvents from './ManagedRunEvents.vue';

const props = defineProps<{ cardId: string }>();
const emit = defineEmits<{ 'open-workflow': [target: { cardId: string; runId: string }] }>();

const board = useBoardStore();
const exec = useExecutionStore();

// This panel owns exactly one watch on its card — mounted with the drawer,
// re-balanced on a card switch.
watch(
  () => props.cardId,
  (id, prev) => {
    if (prev && prev !== id) exec.unwatchCard(prev);
    if (id) exec.watchCard(id);
  },
);

onMounted(() => {
  exec.watchCard(props.cardId);
  void exec.loadPresets();
});
onBeforeUnmount(() => {
  exec.unwatchCard(props.cardId);
});
// watch() without immediate:true only fires on CHANGE — mount attaches the
// first watch and unmount balances the last one.

const st = computed(() => exec.stateFor(props.cardId));
const view = computed(() => st.value.view);
const boardCard = computed(() => board.cards.find((c) => c.id === props.cardId) ?? null);
const offline = computed(() => exec.online === false);
const busy = computed(() => st.value.busy !== null);

/** UI generation — bumped on every card switch AND unmount, so a promise
 * issued for the old card/editor context dies with it. */
let uiSeq = 0;
const stillCurrent = (cardId: string, seq: number) => props.cardId === cardId && seq === uiSeq;

function gated(gate: { ok: boolean; reason: string }): { disabled: boolean; title: string } {
  if (offline.value) return { disabled: true, title: 'state server unreachable — actions are disabled' };
  if (busy.value) {
    return { disabled: true, title: `a ${st.value.busy} command is still in flight` };
  }
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

// ---- enable -----------------------------------------------------------------

const eligibility = computed(() => {
  const c = boardCard.value;
  if (!c) return { ok: false, reasons: ['card not found'] };
  return enableEligibility({
    cancelled: c.cancelled,
    projectResolvable: !!board.projectIdForCard(c),
    projectLabel: c.project,
  });
});

async function onEnable() {
  if (!confirm(
    'Enable managed execution for this card?\n\n' +
      'The execution engine takes over the card\u2019s stage, status, flags, ' +
      'project and session — those fields become read-only on the board.',
  )) return;
  await send('enable');
}

// ---- documents ---------------------------------------------------------------

const DOC_KINDS: ExecDocKind[] = ['requirements', 'plan', 'design'];
const docTab = ref<ExecDocKind>('requirements');
const docVersions = computed(() => {
  if (!view.value) return [];
  return [...docState(view.value, docTab.value).versions].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
});
const docSelectedId = ref<string | null>(null);
const selectedVersion = computed(() => {
  if (!view.value) return null;
  const d = docState(view.value, docTab.value);
  const want = docSelectedId.value ?? d.current;
  return d.versions.find((v) => v.versionId === want) ?? null;
});

// Viewed document content vs load failure are SEPARATE — an error text is
// never a seed for a new document version.
const docViewText = ref<string | null>(null);
const docViewError = ref<string | null>(null);
const docViewFor = ref<string | null>(null);
const docViewLoading = ref(false);
let docViewSeq = 0;

const docDraft = ref('');
const docImportPath = ref('');
const docEditorOpen = ref(false);
/** Which version the draft was seeded from + a token guarding the async
 * seed fetch against user typing that started meanwhile. */
const docDraftSeed = ref<string | null>(null);
let docSeedSeq = 0;
const planCheckRows = ref<CheckRow[] | null>(null); // null = derive from version

/** Doc-tab context reset — editor, viewer and check rows all belong to the
 * kind+version they were opened for. */
function resetDocUi() {
  docViewSeq += 1;
  docSeedSeq += 1;
  docSelectedId.value = null;
  docViewText.value = null;
  docViewError.value = null;
  docViewFor.value = null;
  docDraft.value = '';
  docDraftSeed.value = null;
  docImportPath.value = '';
  docEditorOpen.value = false;
  planCheckRows.value = null;
}
watch(docTab, resetDocUi);

// A card switch invalidates EVERYTHING this panel was doing: doc context,
// preset editor/selection, run-control inputs and any in-flight callback.
// Nothing typed for card A may survive onto card B.
watch(
  () => props.cardId,
  () => {
    uiSeq += 1;
    resetDocUi();
    presetEditorOpen.value = false;
    presetDraft.value = emptyPresetDraft();
    presetBindId.value = '';
    startBaseRef.value = '';
    startFreshWorkspace.value = false;
    continueNote.value = '';
    artifactSeq += 1;
    openedArtifact.value = null;
    fusionEditorOpen.value = false;
    orchEditorOpen.value = false;
    swarmEditorOpen.value = false;
  },
);
onBeforeUnmount(() => {
  uiSeq += 1;
  docViewSeq += 1;
  docSeedSeq += 1;
  artifactSeq += 1;
});

const docApproval = computed(() => {
  const a = view.value?.approvals;
  if (!a) return null;
  return docTab.value === 'requirements' ? a.requirements : docTab.value === 'plan' ? a.plan : null;
});
const selectedApproved = computed(
  () =>
    !!selectedVersion.value &&
    docApproval.value?.versionId === selectedVersion.value.versionId &&
    docApproval.value.sha256 === selectedVersion.value.sha256,
);

async function onViewDoc() {
  const v = selectedVersion.value;
  if (!v) return;
  const cardId = props.cardId;
  const seq = ++docViewSeq;
  docViewLoading.value = true;
  docViewError.value = null;
  try {
    const d = await exec.getDocument(cardId, v.versionId);
    if (seq !== docViewSeq || cardId !== props.cardId) return;
    docViewText.value = d.content;
    docViewError.value = null;
    docViewFor.value = v.versionId;
  } catch (e) {
    if (seq !== docViewSeq || cardId !== props.cardId) return;
    docViewText.value = null;
    docViewError.value = e instanceof Error ? e.message : String(e);
    docViewFor.value = v.versionId;
  } finally {
    if (seq === docViewSeq && cardId === props.cardId) docViewLoading.value = false;
  }
}

function onEditDoc() {
  const v = selectedVersion.value;
  docEditorOpen.value = true;
  docImportPath.value = '';
  if (!v) return;
  if (docViewFor.value === v.versionId && docViewText.value !== null) {
    docDraft.value = docViewText.value;
    docDraftSeed.value = v.versionId;
    return;
  }
  // Content not loaded yet — fetch it as the seed. If the user starts
  // typing before the response lands, the seed must NOT overwrite them:
  // the token guard below compares a pre-typing snapshot.
  docDraft.value = '';
  docDraftSeed.value = v.versionId;
  const cardId = props.cardId;
  const seedSeq = ++docSeedSeq;
  void exec.getDocument(cardId, v.versionId).then(
    (d) => {
      if (seedSeq !== docSeedSeq || cardId !== props.cardId) return;
      if (docDraftSeed.value !== v.versionId) return;
      if (docDraft.value !== '') return; // user typed first — keep it
      docDraft.value = d.content;
    },
    () => {
      // Seed failure leaves the editor empty — an error is never document
      // content.
    },
  );
}

async function onAttachDoc() {
  const kind = docTab.value;
  const source: DocSourceInput = docImportPath.value.trim()
    ? { type: 'import', path: docImportPath.value.trim() }
    : { type: 'text', text: docDraft.value };
  const opts: { requirementsVersionId?: string; checks?: ExecCheck[] } = {};
  if (kind === 'plan' && planCheckRows.value !== null) {
    const v = rowsToChecks(planCheckRows.value);
    if (!v.ok) {
      alert(`check list is not valid:\n${v.problems.join('\n')}`);
      return;
    }
    if (v.checks.length) opts.checks = v.checks;
  }
  const ok = await send('attach_document', attachDocPayload(kind, source, opts));
  if (ok && props.cardId) {
    docEditorOpen.value = false;
    docDraft.value = '';
    docDraftSeed.value = null;
    docImportPath.value = '';
    docSelectedId.value = null;
    planCheckRows.value = null;
  }
}

/** Render one confirmed check exactly as it will be bound — command, cwd,
 * timeout and setup flag all visible. */
function checkLine(c: ExecCheck, i: number): string {
  const parts = [`${i + 1}. ${c.run}`];
  if (c.cwd) parts.push(`cwd ${c.cwd}`);
  if (c.timeoutSec !== undefined) parts.push(`timeout ${c.timeoutSec}s`);
  if (c.setup === true) parts.push('with setup');
  return parts.join(' · ');
}

async function onApproveDoc() {
  const v = selectedVersion.value;
  if (!v || !view.value) return;
  if (docTab.value === 'design') return; // design is informational, not approved
  const extra: Record<string, unknown> = {};
  if (docTab.value === 'plan') {
    // The approval binds the exact check set shown — editor rows override
    // attach-time/document checks, mirroring the server's precedence. A
    // malformed editor row aborts instead of silently approving a derived
    // set the user never saw.
    if (planCheckRows.value !== null) {
      const v2 = rowsToChecks(planCheckRows.value);
      if (!v2.ok) {
        alert(`check list is not valid — nothing is approved:\n${v2.problems.join('\n')}`);
        return;
      }
    }
    const eff = effectivePlanChecks(v, planCheckRows.value);
    if (!eff.checks.length) {
      alert(`plan approval needs a confirmed check list — ${eff.problems.join('; ')}`);
      return;
    }
    if (!confirm(
      `Approve plan ${shortId(v.versionId)} (${fmtSha(v.sha256)}) with these checks ` +
        `(from ${eff.source.replace(/_/g, ' ')})?\n\n` +
        eff.checks.map((c, i) => checkLine(c, i)).join('\n'),
    )) return;
    extra.checks = eff.checks;
  } else if (!confirm(
    `Approve requirements ${shortId(v.versionId)} (${fmtSha(v.sha256)})?\n\n` +
      'Approvals bind to this exact version — attaching a new version requires a new approval.',
  )) return;
  await send(docTab.value === 'requirements' ? 'approve_requirements' : 'approve_plan', {
    versionId: v.versionId,
    sha256: v.sha256,
    ...extra,
  });
}

const planCheckHint = computed(() => {
  const v = selectedVersion.value;
  if (!v || docTab.value !== 'plan') return null;
  return effectivePlanChecks(v, planCheckRows.value);
});

function addCheckRow() {
  const seed =
    planCheckRows.value ??
    checksToRows(
      selectedVersion.value?.checks?.checks ??
        (selectedVersion.value?.checksFromDocument?.ok
          ? selectedVersion.value.checksFromDocument.checks
          : []),
    );
  planCheckRows.value = [...seed, { run: '', cwd: '', timeoutSec: '', setup: false }];
}

// ---- composition --------------------------------------------------------------

const ROLES: ExecRole[] = ['implementer', 'reviewer', 'checker'];
const presetEditorOpen = ref(false);
const presetDraft = ref<{
  id: string | null;
  name: string;
  members: Record<ExecRole, { cli: string; model: string; effort: string; params: string }>;
  limits: { maxAttemptsPerRole: string; timeoutMin: string; maxReviewRounds: string };
}>(emptyPresetDraft());
const presetBindId = ref('');

function emptyPresetDraft() {
  return {
    id: null,
    name: '',
    members: {
      implementer: { cli: 'pi', model: '', effort: '', params: '' },
      reviewer: { cli: 'pi', model: '', effort: '', params: '' },
      checker: { cli: 'pi', model: '', effort: '', params: '' },
    },
    limits: { maxAttemptsPerRole: '1', timeoutMin: '60', maxReviewRounds: '3' },
  };
}

function presetToInput(): { ok: boolean; input?: ExecPresetInput; problems: string[] } {
  const problems: string[] = [];
  const members = {} as Record<ExecRole, { cli: string; model: string; effort?: string; params?: Record<string, unknown> }>;
  for (const role of ROLES) {
    const m = presetDraft.value.members[role];
    if (!m.cli) { problems.push(`${role}: cli is required`); continue; }
    if (!m.model.trim()) { problems.push(`${role}: model is required`); continue; }
    const member: { cli: string; model: string; effort?: string; params?: Record<string, unknown> } = {
      cli: m.cli,
      model: m.model.trim(),
    };
    if (m.effort.trim()) member.effort = m.effort.trim();
    if (m.params.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.params);
      } catch (e) {
        problems.push(`${role}: params is not valid JSON — ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        problems.push(`${role}: params must be a JSON object like {"key": "value"}`);
        continue;
      }
      member.params = parsed as Record<string, unknown>;
    }
    members[role] = member;
  }
  const limits: Record<string, number> = {};
  for (const [key, raw] of Object.entries(presetDraft.value.limits)) {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) {
      problems.push(`limit ${key} must be a positive number`);
      continue;
    }
    limits[key] = n;
  }
  if (!presetDraft.value.name.trim()) problems.push('preset name is required');
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems,
    input: {
      ...(presetDraft.value.id ? { id: presetDraft.value.id } : {}),
      name: presetDraft.value.name.trim(),
      members: members as ExecPresetInput['members'],
      limits: limits as ExecPresetInput['limits'],
    },
  };
}

function loadPresetIntoEditor(id: string) {
  const p = exec.presets.find((x) => x.id === id);
  if (!p) return;
  presetDraft.value = {
    id: p.id,
    name: p.name,
    members: {
      implementer: {
        cli: p.members.implementer?.cli ?? 'pi',
        model: p.members.implementer?.model ?? '',
        effort: p.members.implementer?.effort ?? '',
        params: p.members.implementer?.params ? JSON.stringify(p.members.implementer.params) : '',
      },
      reviewer: {
        cli: p.members.reviewer?.cli ?? 'pi',
        model: p.members.reviewer?.model ?? '',
        effort: p.members.reviewer?.effort ?? '',
        params: p.members.reviewer?.params ? JSON.stringify(p.members.reviewer.params) : '',
      },
      checker: {
        cli: p.members.checker?.cli ?? 'pi',
        model: p.members.checker?.model ?? '',
        effort: p.members.checker?.effort ?? '',
        params: p.members.checker?.params ? JSON.stringify(p.members.checker.params) : '',
      },
    },
    limits: {
      maxAttemptsPerRole: String(p.limits?.maxAttemptsPerRole ?? 1),
      timeoutMin: String(p.limits?.timeoutMin ?? 60),
      maxReviewRounds: String(p.limits?.maxReviewRounds ?? 3),
    },
  };
  presetEditorOpen.value = true;
}

async function onSavePreset() {
  const built = presetToInput();
  if (!built.ok || !built.input) {
    alert(`preset is not valid:\n${built.problems.join('\n')}`);
    return;
  }
  // save_preset upserts the registry AND binds a snapshot to this card in
  // one command — an incompatible cli/model/effort/param comes back as a
  // visible server validation error, never a silent fallback.
  const cardId = props.cardId;
  const seq = uiSeq;
  const ok = await send('save_preset', presetCommandPayload(built.input));
  if (!ok) return;
  // Reload the registry so the selector shows the saved entry. The context
  // is re-checked AFTER the await — a card switch during the reload must
  // not let this callback close the new card's editor.
  await exec.loadPresets();
  if (stillCurrent(cardId, seq)) presetEditorOpen.value = false;
}

async function onBindPreset() {
  const p = exec.presets.find((x) => x.id === presetBindId.value);
  if (!p) return;
  await send('save_preset', presetCommandPayload({
    id: p.id,
    name: p.name,
    members: p.members,
    limits: p.limits,
  }));
}

async function onDeletePreset(id: string) {
  const p = exec.presets.find((x) => x.id === id);
  if (!p || !confirm(`Delete preset "${p.name}"? Cards already bound keep their snapshot.`)) return;
  const r = await exec.removePreset(id);
  if (!r.ok) alert(r.error ?? 'could not delete the preset');
}

const compositionLine = computed(() => {
  const comp = view.value?.composition;
  if (!comp?.preset) return null;
  const p = comp.preset;
  return ROLES.map((r) => `${r} ${p.members?.[r]?.cli ?? '?'}·${p.members?.[r]?.model ?? '?'}`).join(' · ');
});

// ---- run control + detail ------------------------------------------------------

const startBaseRef = ref('');
const startFreshWorkspace = ref(false);
const continueNote = ref('');
const run = computed(() => st.value.run);
const runWorkspace = computed(() => {
  const r = run.value;
  return r?.workspaceId ? view.value?.workspaces?.[r.workspaceId] ?? null : null;
});

const startGate = computed(() => (view.value ? canStart(view.value) : { ok: false, reason: 'loading' }));
const stopGate = computed(() => (view.value ? canStop(view.value) : { ok: false, reason: 'loading' }));
const continueGate = computed(() =>
  view.value ? canContinue(view.value, run.value) : { ok: false, reason: 'loading' });
const acceptGate = computed(() =>
  view.value ? canAccept(view.value, run.value) : { ok: false, reason: 'loading' });

async function onStart() {
  const ok = await send('start', startPayload({
    baseRef: startBaseRef.value,
    freshWorkspace: startFreshWorkspace.value,
  }));
  if (ok) {
    startBaseRef.value = '';
    startFreshWorkspace.value = false;
  }
}

async function onStop() {
  const reason = prompt('Stop reason (optional):', '');
  if (reason === null) return; // cancelled — no command sent
  await send('stop', stopPayload(reason));
}

async function onContinue() {
  const ok = await send('continue', continuePayload(continueNote.value));
  if (ok) continueNote.value = '';
}

async function onChangeRequirements() {
  if (!confirm(
    'Change requirements?\n\nThis revokes the requirements and plan approvals ' +
      'and stops any work still running. The new requirements need their own approval.',
  )) return;
  await send('change_requirements');
}

async function onAccept() {
  const r = run.value;
  if (!r) return;
  const payload = acceptPayload(r);
  if (!payload) {
    alert('the run carries no recorded result hash — evidence is incomplete');
    return;
  }
  if (!confirm(
    `Accept this result?\n\nWorkspace ${runWorkspace.value?.path ?? r.workspaceId ?? '—'}\n` +
      `branch ${runWorkspace.value?.branch ?? '—'} · result ${fmtSha(String(payload.resultSha256), 16)}…\n\n` +
      'The live workspace hash must still match the reviewed result.',
  )) return;
  await send('accept_result', payload);
}

const reservedLine = computed(() => {
  const reserved = view.value ? reservedRuns(view.value) : [];
  return reserved.length
    ? `live reservation: ${reserved.map((r) => shortId(r.id)).join(', ')}`
    : '';
});

/** Inputs the selected run was launched with — the bound evidence set. */
const runInputs = computed(() => {
  const r = run.value;
  if (!r?.inputs) return null;
  const i = r.inputs;
  return {
    requirements: i.requirements ? `${shortId(i.requirements.versionId)} · ${fmtSha(i.requirements.sha256, 8)}` : '—',
    plan: i.plan ? `${shortId(i.plan.versionId)} · ${fmtSha(i.plan.sha256, 8)}` : '—',
    design: i.design ? `${shortId(i.design.versionId)} · ${fmtSha(i.design.sha256, 8)}` : '—',
  };
});
/** The approved check list the run launched with — report.index names an
 * entry HERE, not an arbitrary array position. */
const runChecks = computed<ExecCheck[]>(() => run.value?.inputs?.plan?.checks ?? []);
const checkReports = computed(() => run.value?.validation?.checks?.reports ?? []);
const reportForIndex = (i: number) => checkReports.value.find((r) => r.index === i) ?? null;
const runRounds = computed(() => run.value?.rounds ?? []);
const runArtifacts = computed(() =>
  Object.entries(run.value?.artifacts ?? {}).map(([id, a]) => ({ id, ...a })),
);
const artifactLabel = (a: { id: string; kind?: string | null; file?: string | null }) =>
  `${a.kind ?? 'artifact'} · ${a.file ?? shortId(a.id)}`;

// ---- verified findings/verdicts ----------------------------------------------
// The current validation's report docs are domain records bound to
// {round, attemptId, artifactSha256, resultSha256}; a fix round's docs live
// on fixContext. Rounds carry the gate decision + id lists; the finding
// text/severity comes from the verified doc, never from caller JSON.

const findingsDoc = computed(() => {
  const doc = run.value?.validation?.reports?.findings?.doc;
  if (doc && 'findings' in doc) return doc;
  const fc = run.value?.fixContext?.findingsDoc;
  return fc ?? null;
});
const verdictsDoc = computed(() => {
  const doc = run.value?.validation?.reports?.verdicts?.doc;
  if (doc && 'verdicts' in doc) return doc;
  const fc = run.value?.fixContext?.verdictsDoc;
  return fc ?? null;
});
/** Latest verdict per finding — the last entry wins (mirrors
 * review-contract verdictMap). */
const latestVerdict = computed(() => {
  const map = new Map<string, string>();
  for (const v of verdictsDoc.value?.verdicts ?? []) map.set(v.findingId, v.verdict);
  return map;
});
const findingsView = computed(() =>
  (findingsDoc.value?.findings ?? []).map((f) => ({
    ...f,
    verdict: latestVerdict.value.get(f.id) ?? null,
  })),
);
const roundFindingText = (id: string): string | null =>
  findingsDoc.value?.findings.find((f) => f.id === id)?.text ?? null;

/** Latest decision record — what blocks acceptance, verbatim. */
const lastRound = computed(() =>
  runRounds.value.length ? runRounds.value[runRounds.value.length - 1] : null,
);

const openedArtifact = ref<{ id: string; runId: string; content: string } | null>(null);
let artifactSeq = 0;
// A run-selection change drops any open/in-flight artifact view — it can
// never render under a different run.
watch(
  () => run.value?.id ?? null,
  () => {
    artifactSeq += 1;
    openedArtifact.value = null;
  },
);
async function onOpenArtifact(artifactId: string) {
  const r = run.value;
  if (!r) return;
  const cardId = props.cardId;
  const runId = r.id;
  const seq = ++artifactSeq;
  const ui = uiSeq;
  try {
    const a = await exec.getArtifact(runId, artifactId);
    if (seq !== artifactSeq || !stillCurrent(cardId, ui) || run.value?.id !== runId) return;
    openedArtifact.value = { id: artifactId, runId, content: a.content };
  } catch (e) {
    if (seq !== artifactSeq || !stillCurrent(cardId, ui) || run.value?.id !== runId) return;
    openedArtifact.value = {
      id: artifactId,
      runId,
      content: `could not load artifact: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function onOpenInWorkflow() {
  const r = run.value;
  if (!r) return;
  emit('open-workflow', { cardId: props.cardId, runId: r.id });
}

// ---- fusion panel (F4) ------------------------------------------------------
// The fusion surface renders ONLY what the durable run.fusion record
// carries — participant/role state, work orders, exclusions, pending
// actions. Model text streamed through artifacts is content, never a
// command: every control here is an explicit button → send() → one
// commandId → one POST. Intermediate tokens cannot become commands because
// no code path reads them as such.

const fz = computed(() => fusionState(run.value));
const fzParticipants = computed(() => fusionParticipants(run.value));
const fzPending = computed(() => fusionPendingActions(run.value));
const fzWorkOrders = computed(() => fusionWorkOrders(run.value));
const fzCurrentWo = computed(() => currentWorkOrder(run.value));
const fzExclusions = computed(() => fz.value?.exclusions ?? []);

// -- editor (start payload composition) --

const fusionEditorOpen = ref(false);
const fusionKind = ref<'document' | 'implementation'>('document');
const fusionPanelists = ref<{ id: string; label: string; model: string }[]>([]);
const fusionSearch = ref(false);
const fusionJudgeModel = ref('');
const fusionIntegratorModel = ref('');
const fusionReviewer = ref({ cli: 'pi', model: '' });
const fusionChecker = ref({ cli: 'pi', model: '' });
const fusionTaskKind = ref<'requirements' | 'design'>('requirements');
const fusionTaskVersionId = ref<string | null>(null);
const fusionAttempts = ref('2');
const fusionTimeoutMin = ref('45');
const fusionBaseRef = ref('');

/** Provider-qualified models the F1 container runtime can serve — the pi
 * compat entry is the only surface that maps onto worker profiles. */
const fusionModels = computed(() => exec.compatibility?.pi?.models ?? []);

const fusionTaskVersions = computed(() => {
  if (!view.value) return [];
  return [...docState(view.value, fusionTaskKind.value).versions].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
});

function openFusionEditor() {
  const ms = fusionModels.value;
  fusionPanelists.value = [
    { id: 'p1', label: 'Panelist A', model: ms[0] ?? '' },
    { id: 'p2', label: 'Panelist B', model: ms[1] ?? ms[0] ?? '' },
  ];
  const members = view.value?.composition?.preset?.members;
  fusionReviewer.value = {
    cli: members?.reviewer?.cli ?? 'pi',
    model: members?.reviewer?.model ?? '',
  };
  fusionChecker.value = {
    cli: members?.checker?.cli ?? 'pi',
    model: members?.checker?.model ?? '',
  };
  fusionJudgeModel.value = ms[0] ?? '';
  fusionIntegratorModel.value = ms[0] ?? '';
  fusionTaskVersionId.value = null;
  fusionEditorOpen.value = true;
}

function addFusionPanelist() {
  const n = fusionPanelists.value.length + 1;
  const ms = fusionModels.value;
  fusionPanelists.value.push({
    id: `p${n}`,
    label: `Panelist ${String.fromCharCode(64 + n)}`,
    model: ms[n - 1] ?? ms[0] ?? '',
  });
}

const fusionDraft = computed<FusionDraft>(() => {
  const ver = fusionTaskVersionId.value
    ? fusionTaskVersions.value.find((v) => v.versionId === fusionTaskVersionId.value)
    : (view.value ? currentVersion(view.value, fusionTaskKind.value) : null);
  return {
    resultKind: fusionKind.value,
    panelists: fusionPanelists.value.map((p) => ({ id: p.id, label: p.label, model: p.model })),
    judgeModel: fusionJudgeModel.value || null,
    integratorModel: fusionIntegratorModel.value || null,
    review: {
      reviewer: fusionReviewer.value.model
        ? { cli: fusionReviewer.value.cli, model: fusionReviewer.value.model } : null,
      checker: fusionChecker.value.model
        ? { cli: fusionChecker.value.cli, model: fusionChecker.value.model } : null,
    },
    search: fusionSearch.value,
    task: ver ? { kind: fusionTaskKind.value, versionId: ver.versionId, sha256: ver.sha256 } : null,
    limits: {
      maxAttemptsPerParticipant: Number(fusionAttempts.value) || undefined,
      timeoutMin: Number(fusionTimeoutMin.value) || undefined,
    },
    baseRef: fusionBaseRef.value,
  };
});

const fusionProblems = computed(() =>
  view.value ? fusionDraftProblems(view.value, fusionDraft.value) : ['loading managed state']);
const fusionStartGate = computed(() =>
  view.value ? canStartFusion(view.value, fusionDraft.value) : { ok: false, reason: 'loading' });

async function onStartFusion() {
  const ok = await send('start', fusionStartPayload(fusionDraft.value));
  if (ok) fusionEditorOpen.value = false;
}

// -- participant/work-order decisions --

const retryGateFor = (pid: string) => canRetryParticipant(run.value, pid);
const excludeGateFor = (pid: string) => canExcludePanelist(run.value, pid);
const woApproveGateFor = (versionId: string) => canApproveWorkOrder(run.value, versionId);

async function onRetryParticipant(pid: string) {
  const r = run.value;
  if (!r) return;
  await send('retry_participant', retryParticipantPayload(r, pid));
}

async function onExcludePanelist(pid: string) {
  const r = run.value;
  if (!r) return;
  const reason = prompt(`Exclude panelist ${pid} — reason (optional):`, 'repeated failures');
  if (reason === null) return;
  if (!confirm(
    `Exclude ${pid} from this panel?\n\nThe exclusion is durable — ` +
      'the participant cannot rejoin this run, and the panel continues without it.',
  )) return;
  await send('exclude_panelist', excludePanelistPayload(r, pid, reason));
}

async function onApproveWorkOrder(wo: FusionWorkOrder | undefined) {
  const r = run.value;
  if (!r || !wo) return;
  const payload = approveWorkOrderPayload(r, wo);
  if (!payload) {
    alert('the work-order record is incomplete — version or hash missing');
    return;
  }
  if (!confirm(
    `Approve work order ${wo.versionId}?\n\n` +
      `verdict: ${wo.verdict ?? '—'} · sha ${fmtSha(wo.sha256, 12)}…\n\n` +
      (fz.value?.resultKind === 'document'
        ? 'This completes the run — the work order becomes the document result.'
        : 'This routes the run to integration with this exact work-order version.'),
  )) return;
  await send('approve_work_order', payload);
}

// ---- orchestrator run graph (backend-ui-contract §§4–5) -------------------
// The graph renders ONLY what the durable run.orchestrator record
// carries — spec version, subtasks with attempts/evidence/waiting, the
// integrate import, pendingActions. Every control is an explicit button
// → send() → one commandId → one POST (orch_approve | orch_answer |
// orch_grant | orch_retry; stop/continue shared). No fake transitions:
// waiting/failed states surface with their unblock action or nothing.

const oz = computed(() => orchState(run.value));
const ozTasks = computed(() => orchTasks(run.value));
const ozPending = computed(() => orchPendingActions(run.value));
const ozStats = computed(() => oz.value?.stats ?? null);
const ozSpec = computed(() => oz.value?.spec ?? null);
const ozIntegrate = computed(() => oz.value?.integrate ?? null);

// -- editor (start payload composition, contract §3) --

const orchEditorOpen = ref(false);
const orchDecomposer = ref('');
const orchVerifier = ref('');
const orchIntegrator = ref('');
const orchWorkers = ref<{ name: string; profileId: string }[]>([]);
const orchAttempts = ref('3');
const orchIntegratorAttempts = ref('2');
const orchMaxSubtasks = ref('16');
const orchSpecApproval = ref(true);
const orchBaseRef = ref('');

/** Profile ids the server accepts — the compat table is the only source
 * (pi entry like the fusion editor; the server digest-binds at start). */
const orchProfiles = computed(() => exec.compatibility?.pi?.models ?? []);

function openOrchEditor() {
  const ms = orchProfiles.value;
  orchDecomposer.value = ms[0] ?? '';
  orchVerifier.value = ms[1] ?? ms[0] ?? '';
  orchIntegrator.value = ms[2] ?? ms[0] ?? '';
  orchWorkers.value = [{ name: 'default', profileId: ms[0] ?? '' }];
  orchEditorOpen.value = true;
}

const orchDraft = computed<OrchDraft>(() => ({
  decomposer: orchDecomposer.value,
  verifier: orchVerifier.value,
  integrator: orchIntegrator.value,
  workers: orchWorkers.value.map((w) => ({ name: w.name, profileId: w.profileId })),
  limits: {
    maxAttemptsPerTask: Number(orchAttempts.value) || undefined,
    maxIntegratorAttempts: Number(orchIntegratorAttempts.value) || undefined,
    maxSubtasks: Number(orchMaxSubtasks.value) || undefined,
    requireSpecApproval: orchSpecApproval.value,
  },
  baseRef: orchBaseRef.value,
}));

const orchProblems = computed(() =>
  view.value ? orchDraftProblems(view.value, orchDraft.value) : ['loading managed state']);
const orchStartGate = computed(() =>
  view.value ? canStartOrchestrator(view.value, orchDraft.value) : { ok: false, reason: 'loading' });

async function onStartOrchestrator() {
  const ok = await send('start', orchStartPayload(orchDraft.value));
  if (ok) orchEditorOpen.value = false;
}

// -- task decisions --

const orchApproveGate = computed(() => canOrchApprove(run.value));
const orchAnswerFor = (taskId: string) => canOrchAnswer(run.value, taskId);
const orchGrantFor = (taskId: string) => canOrchGrant(run.value, taskId);
const orchRetryFor = (taskId: string) => canOrchRetry(run.value, taskId);
const orchAnswerDrafts = ref<Record<string, string>>({});

async function onOrchApprove() {
  const r = run.value;
  const sha = ozSpec.value?.sha256;
  if (!r || !sha) return;
  if (!confirm(
    `Approve decomposition spec ${fmtSha(sha, 12)}…?\n\n` +
      'This freezes the spec — ready tasks promote and work begins.',
  )) return;
  await send('orch_approve', orchApprovePayload(r, sha));
}

async function onOrchAnswer(taskId: string) {
  const r = run.value;
  const text = (orchAnswerDrafts.value[taskId] ?? '').trim();
  if (!r || !text) return;
  const ok = await send('orch_answer', orchAnswerPayload(r, taskId, text));
  if (ok) delete orchAnswerDrafts.value[taskId];
}

async function onOrchGrant(taskId: string) {
  const r = run.value;
  if (!r) return;
  const raw = prompt(`Grant task ${taskId} extra attempts — how many?`, '1');
  if (raw === null) return;
  const attempts = Math.floor(Number(raw));
  if (!Number.isFinite(attempts) || attempts <= 0) {
    alert('attempts must be a positive number');
    return;
  }
  await send('orch_grant', orchGrantPayload(r, taskId, attempts));
}

async function onOrchRetry(taskId: string) {
  const r = run.value;
  if (!r) return;
  await send('orch_retry', orchRetryPayload(r, taskId));
}

// ---- swarm run state (backend-ui-contract §§6–7) --------------------------
// The swarm renders ONLY what the durable run.swarm record carries —
// participants with turn budget/attempt/waiting, contested ownership,
// broker-escalated decisions, the message bus, freeze state, findings and
// limits. Controls are explicit buttons → send() → one commandId → one
// POST (swarm_input | swarm_extend | swarm_decide; stop/continue
// shared). While frozen the UI disables apply expectations and shows the
// freeze reason — the broker rejects those edits anyway.

const sw = computed(() => swarmState(run.value));
const swParticipants = computed(() => swarmParticipants(run.value));
const swPending = computed(() => swarmPendingActions(run.value));
const swMessages = computed(() => swarmMessages(run.value));
const swDecisions = computed(() => swarmDecisions(run.value));
const swFrozen = computed(() => swarmFrozen(run.value));
const swLimits = computed(() => sw.value?.limits ?? null);
const swFindings = computed(() => sw.value?.findings ?? []);
const swOwnership = computed(() => sw.value?.ownership ?? []);

// -- editor (start payload composition, contract §3) --

const swarmEditorOpen = ref(false);
const swarmParts = ref<{ participantId: string; callsign: string; profileId: string; ownedPaths: string }[]>([]);
const swarmTurns = ref('8');
const swarmRounds = ref('4');
const swarmMaxMessages = ref('200');
const swarmVerify = ref(true);
const swarmBaseRef = ref('');

function openSwarmEditor() {
  const ms = orchProfiles.value;
  swarmParts.value = [
    { participantId: 'p1', callsign: 'A', profileId: ms[0] ?? '', ownedPaths: 'src/a/**' },
    { participantId: 'p2', callsign: 'B', profileId: ms[1] ?? ms[0] ?? '', ownedPaths: 'src/b/**' },
  ];
  swarmEditorOpen.value = true;
}

function addSwarmParticipant() {
  const n = swarmParts.value.length + 1;
  const ms = orchProfiles.value;
  swarmParts.value.push({
    participantId: `p${n}`,
    callsign: String.fromCharCode(64 + n),
    profileId: ms[n - 1] ?? ms[0] ?? '',
    ownedPaths: `src/p${n}/**`,
  });
}

const swarmDraft = computed<SwarmDraft>(() => ({
  participants: swarmParts.value.map((p) => ({
    participantId: p.participantId,
    callsign: p.callsign,
    profileId: p.profileId,
    ownedPaths: p.ownedPaths,
  })),
  limits: {
    maxTurnsPerParticipant: Number(swarmTurns.value) || undefined,
    maxRounds: Number(swarmRounds.value) || undefined,
    maxMessages: Number(swarmMaxMessages.value) || undefined,
    verifyRequired: swarmVerify.value,
  },
  baseRef: swarmBaseRef.value,
}));

const swarmProblems = computed(() =>
  view.value ? swarmDraftProblems(view.value, swarmDraft.value) : ['loading managed state']);
const swarmStartGate = computed(() =>
  view.value ? canStartSwarm(view.value, swarmDraft.value) : { ok: false, reason: 'loading' });

async function onStartSwarm() {
  const ok = await send('start', swarmStartPayload(swarmDraft.value));
  if (ok) swarmEditorOpen.value = false;
}

// -- participant decisions --

const swarmInputDrafts = ref<Record<string, string>>({});
const swarmBroadcast = ref('');
const swarmDecideNotes = ref<Record<string, string>>({});

async function onSwarmInput(participantId: string) {
  const r = run.value;
  const text = participantId === 'all'
    ? swarmBroadcast.value.trim()
    : (swarmInputDrafts.value[participantId] ?? '').trim();
  if (!r || !text) return;
  const ok = await send('swarm_input', swarmInputPayload(r, participantId, text));
  if (ok) {
    if (participantId === 'all') swarmBroadcast.value = '';
    else delete swarmInputDrafts.value[participantId];
  }
}

async function onSwarmExtend(participantId?: string | null) {
  const r = run.value;
  if (!r) return;
  const raw = prompt(
    `Extend ${participantId ? `participant ${participantId}` : 'the swarm'} — extra turns?`, '4');
  if (raw === null) return;
  const turns = Math.floor(Number(raw));
  if (!Number.isFinite(turns) || turns <= 0) {
    alert('turns must be a positive number');
    return;
  }
  await send('swarm_extend', swarmExtendPayload(r, turns, participantId ?? null));
}

async function onSwarmDecide(decisionId: string, outcome: 'approve' | 'reject') {
  const r = run.value;
  if (!r) return;
  const note = (swarmDecideNotes.value[decisionId] ?? '').trim();
  if (!confirm(`${outcome === 'approve' ? 'Approve' : 'Reject'} contested decision ${decisionId}?`)) return;
  await send('swarm_decide', swarmDecidePayload(r, decisionId, outcome, note));
}
</script>

<template>
  <div class="field exec-panel" data-testid="execution-panel">
    <div class="art-head">
      <span class="field-label">Managed execution</span>
      <span
        class="status-token mono"
        :class="offline ? 'tok-blocked' : 'tok-none'"
        data-testid="exec-online"
        :title="offline ? 'the state server is unreachable — every action is disabled until it answers again' : 'connected to the state server'"
      >{{ offline ? 'offline' : 'online' }}</span>
      <button
        class="art-refresh"
        data-testid="exec-refresh"
        title="Reload the managed state now"
        :disabled="st.phase === 'loading'"
        @click="exec.refreshCard(props.cardId)"
      >↻</button>
    </div>

    <p v-if="st.commandError" class="art-error" data-testid="exec-command-error">
      {{ st.commandError.error }}
      <button class="exec-dismiss" title="dismiss" @click="exec.clearCommandError(props.cardId)">×</button>
    </p>
    <p v-else-if="st.error && st.phase !== 'unmanaged'" class="art-error" data-testid="exec-error">
      {{ st.error }}
    </p>

    <!-- Unmanaged card: explicit opt-in only — never auto-enabled. -->
    <template v-if="st.phase === 'unmanaged' || (!view && st.phase !== 'loading' && st.phase !== 'error')">
      <p class="art-note" data-testid="exec-unmanaged">
        This card is not managed yet. Enabling hands its stage, status, flags,
        project and session to the execution engine — they become read-only here.
      </p>
      <p v-for="r in eligibility.reasons" :key="r" class="art-note exec-warn">{{ r }}</p>
      <button
        class="btn primary exec-btn"
        data-testid="exec-enable"
        :disabled="offline || busy || !eligibility.ok"
        :title="!eligibility.ok ? eligibility.reasons.join('; ') : ''"
        @click="onEnable"
      >Enable managed execution</button>
    </template>

    <p v-else-if="!view" class="art-note">Loading managed state…</p>

    <template v-else>
      <!-- authoritative snapshot line -->
      <p class="exec-line mono" data-testid="exec-status-line">
        <span>rev {{ view.controlRevision }}</span>
        <span v-if="view.projection"> · {{ view.projection.stage }}<template v-if="view.projection.status">/{{ view.projection.status }}</template></span>
        <span v-if="view.project"> · {{ view.project.label }}</span>
      </p>
      <p v-if="reservedLine" class="exec-warn mono" data-testid="exec-reserved">{{ reservedLine }}</p>

      <!-- documents -->
      <div class="exec-block" data-testid="exec-documents">
        <div class="exec-blockhead">
          <span class="exec-blocktitle">Documents</span>
          <div class="exec-doc-tabs" role="tablist">
            <button
              v-for="k in DOC_KINDS"
              :key="k"
              class="tab-btn"
              :class="{ active: docTab === k }"
              role="tab"
              :aria-selected="docTab === k"
              @click="docTab = k"
            >{{ docKindLabel(k) }}</button>
          </div>
        </div>

        <template v-if="docVersions.length">
          <select v-model="docSelectedId" class="f-input exec-select" data-testid="doc-version-pick">
            <option :value="null">current ({{ shortId(docState(view, docTab).current) }})</option>
            <option v-for="v in docVersions" :key="v.versionId" :value="v.versionId">
              {{ shortId(v.versionId) }} · {{ fmtTs(v.createdAt) }} · {{ fmtSha(v.sha256, 8) }}
            </option>
          </select>
          <p v-if="selectedVersion" class="exec-line mono">
            {{ shortId(selectedVersion.versionId) }} · {{ fmtSha(selectedVersion.sha256) }} ·
            {{ fmtTs(selectedVersion.createdAt) }} · {{ selectedVersion.bytes }} B
            <template v-if="selectedApproved"> · approved</template>
            <template v-else-if="docApproval"> · <span class="exec-warn">not the approved version</span></template>
          </p>
          <p v-if="selectedVersion && planBindingNote(selectedVersion, view)" class="exec-warn">
            {{ planBindingNote(selectedVersion, view) }}
          </p>
          <p v-if="docTab === 'plan' && selectedVersion && planCheckHint" class="exec-line mono" data-testid="plan-checks-hint">
            checks: {{ planCheckHint.checks.length ? `${planCheckHint.checks.length} (${planCheckHint.source.replace(/_/g, ' ')})` : 'none — required for approval' }}
          </p>
          <div class="exec-btnrow">
            <button class="btn" data-testid="doc-view" :disabled="docViewLoading" @click="onViewDoc">
              {{ docViewLoading ? 'Loading…' : 'View' }}
            </button>
            <button class="btn" data-testid="doc-edit" @click="onEditDoc">New version from this</button>
            <button
              v-if="docTab !== 'design'"
              class="btn primary"
              data-testid="doc-approve"
              :disabled="offline || busy || !selectedVersion || selectedApproved"
              :title="selectedApproved ? 'this exact version is already approved' : ''"
              @click="onApproveDoc"
            >Approve {{ docKindLabel(docTab).toLowerCase() }}</button>
          </div>
          <p v-if="docViewFor === selectedVersion?.versionId && docViewError" class="art-error" data-testid="doc-load-error">
            could not load the document: {{ docViewError }}
          </p>
          <pre v-else-if="docViewFor === selectedVersion?.versionId && docViewText !== null" class="exec-docview mono" data-testid="doc-content">{{ docViewText }}</pre>
        </template>
        <p v-else class="art-note">No {{ docKindLabel(docTab).toLowerCase() }} yet.</p>

        <!-- attach editor — while a command is in flight the editor is
             frozen: text typed during the POST can never be silently
             cleared by the success path. -->
        <div v-if="docEditorOpen" class="exec-editor" data-testid="doc-editor">
          <textarea
            v-model="docDraft"
            class="f-input exec-area mono"
            rows="8"
            :disabled="busy"
            :placeholder="`${docKindLabel(docTab)} markdown — or leave empty and give an import path below`"
            data-testid="doc-draft"
          />
          <p v-if="docDraftSeed" class="exec-line mono">editing seed: {{ shortId(docDraftSeed) }}</p>
          <div class="exec-importrow">
            <input
              v-model="docImportPath"
              class="f-input mono"
              :disabled="busy"
              placeholder="or import from project-relative path (e.g. docs/reqs.md)"
              data-testid="doc-import-path"
            />
          </div>

          <!-- plan check editor -->
          <template v-if="docTab === 'plan'">
            <div class="exec-checks" data-testid="plan-checks">
              <span class="field-label">Check commands (confirmed at approval)</span>
              <div v-for="(row, i) in planCheckRows ?? []" :key="i" class="check-editrow">
                <input v-model="row.run" class="f-input mono" placeholder="npm run test" aria-label="check command" :disabled="busy" />
                <input v-model="row.cwd" class="f-input mono check-cwd" placeholder="cwd" aria-label="check cwd" :disabled="busy" />
                <input v-model="row.timeoutSec" class="f-input check-tmo" placeholder="sec" aria-label="check timeout" :disabled="busy" />
                <label class="check-setup"><input v-model="row.setup" type="checkbox" :disabled="busy" /> setup</label>
                <button class="link-del" aria-label="remove check" :disabled="busy" @click="planCheckRows!.splice(i, 1)">×</button>
              </div>
              <button class="link-add" data-testid="add-check" :disabled="busy" @click="addCheckRow">+ Add check</button>
            </div>
          </template>

          <div class="exec-btnrow">
            <button
              class="btn primary"
              data-testid="doc-attach"
              :disabled="offline || busy || (!docDraft.trim() && !docImportPath.trim())"
              @click="onAttachDoc"
            >{{ st.busy === 'attach_document' ? 'Attaching…' : 'Attach new version' }}</button>
            <button class="btn" :disabled="busy" @click="docEditorOpen = false">Close</button>
          </div>
          <p v-if="busy" class="art-note">command in flight — the editor is frozen until it lands</p>
        </div>
        <button v-else class="link-add" data-testid="doc-new" @click="docEditorOpen = true">
          + New {{ docKindLabel(docTab).toLowerCase() }} version
        </button>
      </div>

      <!-- composition -->
      <div class="exec-block" data-testid="exec-composition">
        <div class="exec-blockhead">
          <span class="exec-blocktitle">Execution team</span>
        </div>
        <p v-if="compositionLine" class="exec-line mono" data-testid="composition-line">
          {{ view.composition!.preset.name }} — {{ compositionLine }}
        </p>
        <p v-else class="art-note" data-testid="composition-missing">
          No execution team saved for this card — pick or create a preset below.
        </p>

        <div v-if="exec.presets.length" class="exec-btnrow">
          <select v-model="presetBindId" class="f-input exec-select" data-testid="preset-pick">
            <option value="">choose a preset…</option>
            <option v-for="p in exec.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <button
            class="btn"
            data-testid="preset-apply"
            :disabled="offline || busy || !presetBindId"
            title="Bind this preset's snapshot to the card"
            @click="onBindPreset"
          >Use for this card</button>
          <button
            class="btn"
            data-testid="preset-edit"
            :disabled="!presetBindId"
            @click="loadPresetIntoEditor(presetBindId)"
          >Edit</button>
          <button
            class="btn danger"
            :disabled="!presetBindId || offline || busy"
            @click="onDeletePreset(presetBindId)"
          >Delete</button>
        </div>
        <button
          v-if="!presetEditorOpen"
          class="link-add"
          data-testid="preset-new"
          @click="presetDraft = emptyPresetDraft(); presetEditorOpen = true"
        >+ New preset</button>

        <div v-if="presetEditorOpen" class="exec-editor" data-testid="preset-editor">
          <input v-model="presetDraft.name" class="f-input" placeholder="Preset name" data-testid="preset-name" />
          <div v-for="role in ROLES" :key="role" class="exec-member">
            <span class="exec-role mono">{{ role }}</span>
            <select v-model="presetDraft.members[role].cli" class="f-input" :aria-label="`${role} cli`">
              <option v-for="cli in Object.keys(exec.compatibility ?? {})" :key="cli" :value="cli">{{ cli }}</option>
            </select>
            <select v-model="presetDraft.members[role].model" class="f-input" :aria-label="`${role} model`">
              <option value="">model…</option>
              <option
                v-for="m in exec.compatibility?.[presetDraft.members[role].cli]?.models ?? []"
                :key="m"
                :value="m"
              >{{ m }}</option>
            </select>
            <select
              v-if="exec.compatibility?.[presetDraft.members[role].cli]?.effort?.length"
              v-model="presetDraft.members[role].effort"
              class="f-input"
              :aria-label="`${role} effort`"
            >
              <option value="">effort…</option>
              <option
                v-for="e in exec.compatibility[presetDraft.members[role].cli].effort ?? []"
                :key="e"
                :value="e"
              >{{ e }}</option>
            </select>
            <input
              v-model="presetDraft.members[role].params"
              class="f-input mono"
              placeholder='params {"key":"value"}'
              :aria-label="`${role} params`"
            />
          </div>
          <div class="exec-limits">
            <label>attempts/role <input v-model="presetDraft.limits.maxAttemptsPerRole" class="f-input exec-num" /></label>
            <label>timeout min <input v-model="presetDraft.limits.timeoutMin" class="f-input exec-num" /></label>
            <label>review rounds <input v-model="presetDraft.limits.maxReviewRounds" class="f-input exec-num" /></label>
          </div>
          <div class="exec-btnrow">
            <button
              class="btn primary"
              data-testid="preset-save"
              :disabled="offline || busy"
              @click="onSavePreset"
            >Save preset + bind to card</button>
            <button class="btn" @click="presetEditorOpen = false">Close</button>
          </div>
          <p v-if="exec.presetsError" class="art-error">{{ exec.presetsError }}</p>
        </div>
        <p v-if="exec.compatError" class="exec-warn" data-testid="compat-error">{{ exec.compatError }}</p>
      </div>

      <!-- fusion panel (F4): compose a multi-panelist run. Visible only
           when the state service reports the fusion gate on — the server
           is authoritative either way (a hidden-off run still refuses). -->
      <div v-if="view.features?.fusion" class="exec-block" data-testid="exec-fusion">
        <div class="exec-blockhead">
          <span class="exec-blocktitle">Fusion panel</span>
          <span v-if="fz" class="exec-line mono" data-testid="fusion-status">
            {{ resultKindLabel(fz.resultKind) }} · panel {{ fusionStatusLabel(fz.status) }}
          </span>
        </div>

        <template v-if="fusionEditorOpen">
          <div class="exec-editor" data-testid="fusion-editor">
            <div class="exec-btnrow">
              <select v-model="fusionKind" class="f-input" data-testid="fusion-kind" aria-label="result kind">
                <option value="document">document — the work order is the result</option>
                <option value="implementation">implementation — integrate + gates</option>
              </select>
              <label class="check-setup">
                <input v-model="fusionSearch" type="checkbox" data-testid="fusion-search" /> web search
              </label>
              <input v-model="fusionBaseRef" class="f-input mono exec-grow" placeholder="base ref (default HEAD)" data-testid="fusion-baseref" />
            </div>

            <div class="exec-members" data-testid="fusion-panelists">
              <div v-for="(p, i) in fusionPanelists" :key="i" class="exec-member exec-member4">
                <input v-model="p.label" class="f-input" :aria-label="`panelist ${p.id} label`" :data-testid="`fusion-plabel-${p.id}`" />
                <select v-model="p.model" class="f-input mono" :aria-label="`panelist ${p.id} model`" :data-testid="`fusion-pmodel-${p.id}`">
                  <option value="">model…</option>
                  <option v-for="m in fusionModels" :key="m" :value="m">{{ m }}</option>
                </select>
                <button
                  v-if="fusionPanelists.length > 2"
                  class="link-del"
                  :aria-label="`remove panelist ${p.id}`"
                  @click="fusionPanelists.splice(i, 1)"
                >×</button>
                <span v-else />
              </div>
              <button class="link-add" data-testid="fusion-add-panelist" @click="addFusionPanelist">+ panelist</button>
            </div>

            <!-- task binding (document runs pin a version; implementation
                 defaults to the approved requirements server-side) -->
            <div class="exec-btnrow" data-testid="fusion-taskrow">
              <select v-model="fusionTaskKind" class="f-input" data-testid="fusion-task-kind" aria-label="task document kind">
                <option value="requirements">task: requirements</option>
                <option value="design">task: design</option>
              </select>
              <select v-model="fusionTaskVersionId" class="f-input mono exec-grow" data-testid="fusion-task-version" aria-label="task version">
                <option :value="null">current version ({{ shortId(docState(view, fusionTaskKind).current) }})</option>
                <option v-for="v in fusionTaskVersions" :key="v.versionId" :value="v.versionId">
                  {{ shortId(v.versionId) }} · {{ fmtSha(v.sha256, 8) }}
                </option>
              </select>
            </div>

            <div class="exec-member" data-testid="fusion-judge-row">
              <span class="exec-role mono">judge{{ fusionKind === 'implementation' ? ' *' : ' (opt)' }}</span>
              <select v-model="fusionJudgeModel" class="f-input mono" data-testid="fusion-judge" aria-label="judge model">
                <option value="">model…</option>
                <option v-for="m in fusionModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>

            <template v-if="fusionKind === 'implementation'">
              <div class="exec-member" data-testid="fusion-integrator-row">
                <span class="exec-role mono">integrator *</span>
                <select v-model="fusionIntegratorModel" class="f-input mono" data-testid="fusion-integrator" aria-label="integrator model">
                  <option value="">model…</option>
                  <option v-for="m in fusionModels" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
              <div class="exec-member" data-testid="fusion-reviewer-row">
                <span class="exec-role mono">reviewer *</span>
                <select v-model="fusionReviewer.cli" class="f-input" data-testid="fusion-reviewer-cli" aria-label="reviewer cli">
                  <option v-for="cli in Object.keys(exec.compatibility ?? {})" :key="cli" :value="cli">{{ cli }}</option>
                </select>
                <select v-model="fusionReviewer.model" class="f-input mono" data-testid="fusion-reviewer-model" aria-label="reviewer model">
                  <option value="">model…</option>
                  <option v-for="m in exec.compatibility?.[fusionReviewer.cli]?.models ?? []" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
              <div class="exec-member" data-testid="fusion-checker-row">
                <span class="exec-role mono">checker *</span>
                <select v-model="fusionChecker.cli" class="f-input" data-testid="fusion-checker-cli" aria-label="checker cli">
                  <option v-for="cli in Object.keys(exec.compatibility ?? {})" :key="cli" :value="cli">{{ cli }}</option>
                </select>
                <select v-model="fusionChecker.model" class="f-input mono" data-testid="fusion-checker-model" aria-label="checker model">
                  <option value="">model…</option>
                  <option v-for="m in exec.compatibility?.[fusionChecker.cli]?.models ?? []" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
            </template>

            <div class="exec-limits">
              <label>attempts/panelist <input v-model="fusionAttempts" class="f-input exec-num" data-testid="fusion-attempts" /></label>
              <label>timeout min <input v-model="fusionTimeoutMin" class="f-input exec-num" data-testid="fusion-timeout" /></label>
            </div>

            <p v-if="fusionProblems.length" class="exec-warn" data-testid="fusion-problems">
              {{ fusionProblems.join(' · ') }}
            </p>
            <div class="exec-btnrow">
              <button
                class="btn primary"
                data-testid="fusion-start"
                :disabled="gated(fusionStartGate).disabled"
                :title="gated(fusionStartGate).title || 'Start a fusion panel run with this composition'"
                @click="onStartFusion"
              >{{ st.busy === 'start' ? 'Starting…' : 'Start fusion run' }}</button>
              <button class="btn" data-testid="fusion-cancel" @click="fusionEditorOpen = false">Close</button>
            </div>
          </div>
        </template>
        <button
          v-else
          class="link-add"
          data-testid="fusion-configure"
          @click="openFusionEditor"
        >+ New fusion run</button>
      </div>

      <!-- orchestrator (backend-ui-contract §§3–5): compose a decomposed run.
           Visible only when the state service reports the orchestrator
           gate on — the server is authoritative either way. Until then
           the handoff offer in the Preparation panel stays the record. -->
      <div v-if="view.features?.orchestrator" class="exec-block" data-testid="exec-orchestrator">
        <div class="exec-blockhead">
          <span class="exec-blocktitle">Orchestrator</span>
          <span v-if="oz" class="exec-line mono" data-testid="orch-status">
            {{ orchPhaseLabel(oz.phase) }}<template v-if="ozStats"> · {{ ozStats.accepted ?? 0 }}/{{ ozStats.tasks ?? 0 }} accepted</template>
          </span>
        </div>

        <template v-if="orchEditorOpen">
          <div class="exec-editor" data-testid="orch-editor">
            <div class="exec-member" data-testid="orch-decomposer-row">
              <span class="exec-role mono">decomposer *</span>
              <select v-model="orchDecomposer" class="f-input mono exec-grow" data-testid="orch-decomposer" aria-label="decomposer profile">
                <option value="">profile…</option>
                <option v-for="m in orchProfiles" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="exec-member" data-testid="orch-verifier-row">
              <span class="exec-role mono">verifier *</span>
              <select v-model="orchVerifier" class="f-input mono exec-grow" data-testid="orch-verifier" aria-label="verifier profile">
                <option value="">profile…</option>
                <option v-for="m in orchProfiles" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="exec-member" data-testid="orch-integrator-row">
              <span class="exec-role mono">integrator *</span>
              <select v-model="orchIntegrator" class="f-input mono exec-grow" data-testid="orch-integrator" aria-label="integrator profile">
                <option value="">profile…</option>
                <option v-for="m in orchProfiles" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="exec-members" data-testid="orch-workers">
              <div v-for="(w, i) in orchWorkers" :key="i" class="exec-member exec-member4">
                <input v-model="w.name" class="f-input mono" :aria-label="`worker ${i} name`" :data-testid="`orch-worker-name-${i}`" placeholder="pool name" />
                <select v-model="w.profileId" class="f-input mono" :aria-label="`worker ${i} profile`" :data-testid="`orch-worker-profile-${i}`">
                  <option value="">profile…</option>
                  <option v-for="m in orchProfiles" :key="m" :value="m">{{ m }}</option>
                </select>
                <button
                  v-if="orchWorkers.length > 1"
                  class="link-del"
                  :aria-label="`remove worker ${i}`"
                  @click="orchWorkers.splice(i, 1)"
                >×</button>
                <span v-else />
              </div>
              <button class="link-add" data-testid="orch-add-worker" @click="orchWorkers.push({ name: '', profileId: orchProfiles[0] ?? '' })">+ worker pool</button>
            </div>
            <div class="exec-btnrow">
              <input v-model="orchBaseRef" class="f-input mono exec-grow" placeholder="base ref (default HEAD)" data-testid="orch-baseref" />
              <label class="check-setup">
                <input v-model="orchSpecApproval" type="checkbox" data-testid="orch-spec-approval" /> require spec approval
              </label>
            </div>
            <div class="exec-limits">
              <label>attempts/task <input v-model="orchAttempts" class="f-input exec-num" data-testid="orch-attempts" /></label>
              <label>integrator attempts <input v-model="orchIntegratorAttempts" class="f-input exec-num" data-testid="orch-integrator-attempts" /></label>
              <label>max subtasks <input v-model="orchMaxSubtasks" class="f-input exec-num" data-testid="orch-max-subtasks" /></label>
            </div>
            <p v-if="orchProblems.length" class="exec-warn" data-testid="orch-problems">
              {{ orchProblems.join(' · ') }}
            </p>
            <div class="exec-btnrow">
              <button
                class="btn primary"
                data-testid="orch-start"
                :disabled="gated(orchStartGate).disabled"
                :title="gated(orchStartGate).title || 'Start an orchestrator run with this composition'"
                @click="onStartOrchestrator"
              >{{ st.busy === 'start' ? 'Starting…' : 'Start orchestrator run' }}</button>
              <button class="btn" data-testid="orch-cancel" @click="orchEditorOpen = false">Close</button>
            </div>
          </div>
        </template>
        <button
          v-else
          class="link-add"
          data-testid="orch-configure"
          @click="openOrchEditor"
        >+ New orchestrator run</button>
      </div>

      <!-- swarm (backend-ui-contract §§3,6–7): compose a swarm run.
           Visible only when the state service reports the swarm gate on. -->
      <div v-if="view.features?.swarm" class="exec-block" data-testid="exec-swarm">
        <div class="exec-blockhead">
          <span class="exec-blocktitle">Swarm</span>
          <span v-if="sw" class="exec-line mono" data-testid="swarm-status">
            {{ swarmPhaseLabel(sw.phase) }} · round {{ sw.round ?? '—' }}
          </span>
        </div>

        <template v-if="swarmEditorOpen">
          <div class="exec-editor" data-testid="swarm-editor">
            <div class="exec-members" data-testid="swarm-participants-edit">
              <div v-for="(p, i) in swarmParts" :key="i" class="exec-member exec-member-swarm">
                <input v-model="p.callsign" class="f-input mono exec-cs" :aria-label="`participant ${i} callsign`" :data-testid="`swarm-callsign-${i}`" placeholder="A" />
                <input v-model="p.participantId" class="f-input mono" :aria-label="`participant ${i} id`" :data-testid="`swarm-pid-${i}`" placeholder="p1" />
                <select v-model="p.profileId" class="f-input mono" :aria-label="`participant ${i} profile`" :data-testid="`swarm-profile-${i}`">
                  <option value="">profile…</option>
                  <option v-for="m in orchProfiles" :key="m" :value="m">{{ m }}</option>
                </select>
                <input v-model="p.ownedPaths" class="f-input mono exec-grow" :aria-label="`participant ${i} owned paths`" :data-testid="`swarm-paths-${i}`" placeholder="src/a/**, docs/**" />
                <button
                  v-if="swarmParts.length > 2"
                  class="link-del"
                  :aria-label="`remove participant ${i}`"
                  @click="swarmParts.splice(i, 1)"
                >×</button>
                <span v-else />
              </div>
              <button v-if="swarmParts.length < 3" class="link-add" data-testid="swarm-add-participant" @click="addSwarmParticipant">+ participant</button>
            </div>
            <div class="exec-btnrow">
              <input v-model="swarmBaseRef" class="f-input mono exec-grow" placeholder="base ref (default HEAD)" data-testid="swarm-baseref" />
              <label class="check-setup">
                <input v-model="swarmVerify" type="checkbox" data-testid="swarm-verify" /> verify required
              </label>
            </div>
            <div class="exec-limits">
              <label>turns/participant <input v-model="swarmTurns" class="f-input exec-num" data-testid="swarm-turns" /></label>
              <label>max rounds <input v-model="swarmRounds" class="f-input exec-num" data-testid="swarm-rounds" /></label>
              <label>max messages <input v-model="swarmMaxMessages" class="f-input exec-num" data-testid="swarm-max-messages" /></label>
            </div>
            <p v-if="swarmProblems.length" class="exec-warn" data-testid="swarm-problems">
              {{ swarmProblems.join(' · ') }}
            </p>
            <div class="exec-btnrow">
              <button
                class="btn primary"
                data-testid="swarm-start"
                :disabled="gated(swarmStartGate).disabled"
                :title="gated(swarmStartGate).title || 'Start a swarm run with this composition'"
                @click="onStartSwarm"
              >{{ st.busy === 'start' ? 'Starting…' : 'Start swarm run' }}</button>
              <button class="btn" data-testid="swarm-cancel" @click="swarmEditorOpen = false">Close</button>
            </div>
          </div>
        </template>
        <button
          v-else
          class="link-add"
          data-testid="swarm-configure"
          @click="openSwarmEditor"
        >+ New swarm run</button>
      </div>

      <!-- run control -->
      <div class="exec-block" data-testid="exec-runcontrol">
        <div class="exec-blockhead">
          <span class="exec-blocktitle">Run</span>
          <span v-if="run" class="exec-line mono" data-testid="run-status">
            {{ shortId(run.id) }} · {{ ['fusion', 'orchestrator', 'swarm'].includes(run.mode) ? `${run.mode} · ` : '' }}{{ runStatusLabel(run.status) }}<template v-if="run.phase"> · {{ phaseLabel(run.phase) }}</template>
          </span>
        </div>

        <div class="exec-btnrow" data-testid="run-actions">
          <button
            class="btn primary"
            data-testid="exec-start"
            :disabled="gated(startGate).disabled"
            :title="gated(startGate).title || 'Start a new run from the approved inputs'"
            @click="onStart"
          >Start</button>
          <button
            class="btn"
            data-testid="exec-stop"
            :disabled="gated(stopGate).disabled"
            :title="gated(stopGate).title || 'Record a durable stop — live attempts are cancelled'"
            @click="onStop"
          >Stop</button>
          <button
            class="btn"
            data-testid="exec-continue"
            :disabled="gated(continueGate).disabled"
            :title="gated(continueGate).title || 'Continue with a new run carrying the workspace forward'"
            @click="onContinue"
          >Continue</button>
          <button
            class="btn"
            data-testid="exec-changereq"
            :disabled="offline || busy"
            title="Revoke the requirements+plan approvals and stop live work"
            @click="onChangeRequirements"
          >Change requirements</button>
          <button
            class="btn primary"
            data-testid="exec-accept"
            :disabled="gated(acceptGate).disabled"
            :title="gated(acceptGate).title || 'Accept the reviewed workspace result'"
            @click="onAccept"
          >Accept result</button>
        </div>
        <p v-if="!startGate.ok || !continueGate.ok || !acceptGate.ok" class="art-note" data-testid="gate-hints">
          {{ [startGate, continueGate, acceptGate].map((g) => g.reason).filter(Boolean).join(' · ') }}
        </p>

        <div class="exec-startrow">
          <input v-model="startBaseRef" class="f-input mono" placeholder="base ref (default HEAD)" data-testid="start-baseref" />
          <label class="check-setup">
            <input v-model="startFreshWorkspace" type="checkbox" /> fresh workspace
          </label>
        </div>
        <input
          v-model="continueNote"
          class="f-input"
          placeholder="note for the continuation run (optional)"
          data-testid="continue-note"
        />

        <!-- selected run detail -->
        <template v-if="run">
          <p v-if="run.error" class="art-error" data-testid="run-error">{{ run.error }}</p>
          <p v-if="run.diagnostic?.detail" class="exec-warn" data-testid="run-diagnostic">{{ run.diagnostic.detail }}</p>

          <!-- the evidence the run was launched / accepted on -->
          <div class="exec-detail" data-testid="run-detail">
            <p class="exec-line mono">
              base {{ run.baseRef }}<template v-if="run.baseCommit"> · {{ fmtSha(run.baseCommit, 8) }}</template>
              <template v-if="runWorkspace"> · {{ runWorkspace.path }} · {{ runWorkspace.branch }}</template>
            </p>
            <p v-if="runInputs" class="exec-line mono" data-testid="run-inputs">
              req {{ runInputs.requirements }} · plan {{ runInputs.plan }}<template v-if="runInputs.design !== '—'"> · design {{ runInputs.design }}</template>
            </p>
            <p v-if="run.acceptance" class="exec-line mono" data-testid="run-acceptance">
              verified result {{ fmtSha(run.acceptance.resultSha256, 16) }}… · round {{ run.acceptance.round }}
            </p>
            <p v-if="run.continuation" class="exec-line mono" data-testid="run-continuation">
              continued from {{ shortId(run.continuation.fromRunId) }} ({{ runStatusLabel(run.continuation.fromStatus) }})<template v-if="run.continuation.userNote"> · “{{ run.continuation.userNote }}”</template>
            </p>
          </div>

          <!-- ============ fusion run detail (F4) ============ -->
          <template v-if="fz">
            <!-- required actions — the durable pendingActions the run is
                 parked on; each row names the exact decision and carries
                 its control. This is the notification surface. -->
            <div v-if="fzPending.length" class="exec-detail exec-pending" data-testid="fusion-actions">
              <span class="exec-subtitle mono">action required</span>
              <div v-for="a in fzPending" :key="a.type + ':' + ((a as Record<string,unknown>).participantId ?? (a as Record<string,unknown>).versionId)" class="exec-actionrow">
                <p class="exec-warn" :data-testid="`fusion-pending-${a.type}`">{{ pendingActionText(a, run) }}</p>
                <template v-if="a.type === 'participant_decision'">
                  <button
                    class="btn exec-actionbtn"
                    :data-testid="`fusion-retry-${a.participantId}`"
                    :disabled="gated(retryGateFor(a.participantId)).disabled"
                    :title="gated(retryGateFor(a.participantId)).title || 'Grant this participant one more attempt'"
                    @click="onRetryParticipant(a.participantId)"
                  >Retry</button>
                  <button
                    class="btn danger exec-actionbtn"
                    :data-testid="`fusion-exclude-${a.participantId}`"
                    :disabled="gated(excludeGateFor(a.participantId)).disabled"
                    :title="gated(excludeGateFor(a.participantId)).title || 'Remove this participant from the panel'"
                    @click="onExcludePanelist(a.participantId)"
                  >Exclude</button>
                </template>
                <button
                  v-else-if="a.type === 'work_order_approval'"
                  class="btn primary exec-actionbtn"
                  :data-testid="`fusion-approve-${a.versionId}`"
                  :disabled="gated(woApproveGateFor(a.versionId)).disabled"
                  :title="gated(woApproveGateFor(a.versionId)).title || 'Approve this work-order version'"
                  @click="onApproveWorkOrder(fzWorkOrders.find((w) => w.versionId === a.versionId)!)"
                >Approve work order</button>
              </div>
            </div>

            <!-- composition + snapshot -->
            <div class="exec-detail" data-testid="fusion-detail">
              <span class="exec-subtitle mono">fusion · {{ resultKindLabel(fz.resultKind) }}</span>
              <p class="exec-line mono" data-testid="fusion-composition">
                panel {{ fusionStatusLabel(fz.status) }}<template v-if="fz.judgeEligible !== null && fz.judgeEligible !== undefined"> · judge eligible {{ fz.judgeEligible }}</template>
                · search {{ fz.snapshot?.search?.enabled ? 'on' : 'off' }}
                · fp {{ fmtSha(fz.fingerprint, 8) }}
              </p>
              <p class="exec-line mono" data-testid="fusion-snapshot">
                task {{ run.inputs?.task ? `${run.inputs.task.kind}/${shortId(run.inputs.task.versionId)} · ${fmtSha(run.inputs.task.sha256, 8)}` : '—' }}
                · project {{ fz.snapshot?.project?.projectRoot ?? '—' }}@{{ fmtSha(fz.snapshot?.project?.snapshotSha, 8) }}
                <template v-if="fz.limits"> · attempts {{ fz.limits.maxAttemptsPerParticipant ?? '?' }} · timeout {{ fz.limits.timeoutMin ?? '?' }}m</template>
              </p>
              <p v-if="fz.continuedFrom" class="exec-line mono">
                continued from {{ shortId(fz.continuedFrom) }}<template v-if="fz.inputReused"> · unchanged inputs — answered work reused</template>
              </p>
            </div>

            <!-- participants -->
            <div class="exec-detail" data-testid="fusion-participants">
              <span class="exec-subtitle mono">panelists</span>
              <div v-for="p in fzParticipants" :key="p.id" class="exec-participant mono" :data-testid="`fusion-participant-${p.id}`">
                <span class="exec-pname">{{ p.id }} · {{ p.label }}</span>
                <span class="exec-pmodel">{{ p.provider }} · {{ p.model }}</span>
                <span :data-status="p.status">{{ participantStatusLabel(p.status) }}</span>
                <span class="exec-pmeta">
                  attempts {{ p.attemptsUsed }}<template v-if="p.extraAttempts"> +{{ p.extraAttempts }}</template>
                </span>
                <button
                  v-if="p.answer?.artifactId"
                  class="exec-artlink"
                  :title="`answer ${fmtSha(p.answer.sha256, 8)}${p.answer.reusedFrom ? ' · reused' : ''}`"
                  @click="onOpenArtifact(p.answer!.artifactId)"
                >answer</button>
                <template v-if="p.status === 'awaiting_decision'">
                  <button
                    class="exec-artlink"
                    :data-testid="`fusion-retry-alt-${p.id}`"
                    :disabled="gated(retryGateFor(p.id)).disabled"
                    @click="onRetryParticipant(p.id)"
                  >retry</button>
                  <button
                    class="exec-artlink"
                    :data-testid="`fusion-exclude-alt-${p.id}`"
                    :disabled="gated(excludeGateFor(p.id)).disabled"
                    @click="onExcludePanelist(p.id)"
                  >exclude</button>
                </template>
                <p v-if="p.lastError?.reason" class="exec-line exec-warn">{{ p.lastError.reason }}</p>
                <p v-if="p.exclusion" class="exec-line">excluded by {{ p.exclusion.by }}<template v-if="p.exclusion.reason"> — {{ p.exclusion.reason }}</template></p>
              </div>
            </div>

            <!-- exclusions record -->
            <div v-if="fzExclusions.length" class="exec-detail" data-testid="fusion-exclusions">
              <span class="exec-subtitle mono">exclusions</span>
              <p v-for="x in fzExclusions" :key="`${x.participantId}-${x.at}`" class="exec-line mono">
                {{ x.participantId }} ({{ x.model }}) — excluded by {{ x.by }} after {{ x.attemptsUsed }} attempt(s)<template v-if="x.reason"> · {{ x.reason }}</template><template v-if="x.carriedFrom"> · carried from {{ shortId(x.carriedFrom) }}</template>
              </p>
            </div>

            <!-- handoff roles -->
            <div v-if="fz.judge || fz.integrator || fz.review" class="exec-detail" data-testid="fusion-roles">
              <span class="exec-subtitle mono">roles</span>
              <p v-if="fz.judge" class="exec-line mono">judge · {{ fz.judge.provider }} · {{ fz.judge.model }}</p>
              <p v-if="fz.integrator" class="exec-line mono">integrator · {{ fz.integrator.provider }} · {{ fz.integrator.model }}</p>
              <p v-if="fz.review" class="exec-line mono">
                reviewer {{ fz.review.reviewer?.cli }}·{{ fz.review.reviewer?.model }}
                · checker {{ fz.review.checker?.cli }}·{{ fz.review.checker?.model }}
              </p>
            </div>

            <!-- work orders — versioned; only the newest is approvable -->
            <div v-if="fzWorkOrders.length" class="exec-detail" data-testid="fusion-workorders">
              <span class="exec-subtitle mono">work orders</span>
              <div v-for="w in fzWorkOrders" :key="w.versionId" class="exec-wo mono" :data-testid="`fusion-wo-${w.versionId}`">
                <p class="exec-line">
                  <strong>{{ w.versionId }}</strong><template v-if="w === fzCurrentWo"> · current</template>
                  · verdict {{ verdictLabel(w.verdict) }}
                  · {{ fmtSha(w.sha256, 12) }}
                </p>
                <p class="exec-line">
                  <template v-if="w.decision">routed {{ w.decision.routed }}<template v-if="w.decision.reason"> ({{ w.decision.reason }})</template> · </template>
                  <template v-if="w.approved">approved by {{ w.approved.by }} · {{ fmtTs(w.approved.at) }}</template>
                  <template v-else-if="fzPending.some((a) => a.type === 'work_order_approval' && a.versionId === w.versionId)"><span class="exec-warn">awaits your approval</span></template>
                  <template v-else>not approved</template>
                  <button class="exec-artlink" :title="`work order ${w.versionId} · ${fmtSha(w.sha256)}`" @click="onOpenArtifact(w.artifactId)">view</button>
                </p>
                <p v-if="w.steps?.length" class="exec-line">steps: {{ w.steps.length }} · affected: {{ (w.affectedParts ?? []).join(', ') }}</p>
                <button
                  v-if="fzPending.some((a) => a.type === 'work_order_approval' && a.versionId === w.versionId)"
                  class="btn primary exec-actionbtn"
                  :data-testid="`fusion-approve-wo`"
                  :disabled="gated(woApproveGateFor(w.versionId)).disabled"
                  :title="gated(woApproveGateFor(w.versionId)).title"
                  @click="onApproveWorkOrder(w)"
                >Approve this work order</button>
              </div>
            </div>
            <p v-if="fz.workOrder" class="exec-line mono" data-testid="fusion-wo-accepted">
              accepted work order {{ fz.workOrder.versionId }} · {{ fmtSha(fz.workOrder.sha256, 12) }} · by {{ fz.workOrder.by }}
            </p>

            <!-- integration state (implementation results) -->
            <div v-if="fz.integrate || fz.integratorReport" class="exec-detail" data-testid="fusion-integrate">
              <span class="exec-subtitle mono">integration</span>
              <p v-if="fz.integrate" class="exec-line mono">
                work order {{ fz.integrate.workOrderVersionId }} · {{ fmtSha(fz.integrate.workOrderSha256, 8) }}
                · {{ fz.integrate.auto ? 'auto-routed' : 'user-approved' }}
                <template v-if="fz.integrate.import">
                  · imported {{ fmtSha(fz.integrate.import.commitSha, 8) }}<template v-if="fz.integrate.import.fix"> (fix #{{ fz.integrate.import.fix }})</template><template v-if="fz.integrate.import.changed === false"> · no changes</template>
                </template>
              </p>
              <p v-if="fz.integratorReport" class="exec-line mono" data-testid="fusion-report">
                integrator report {{ fmtSha(fz.integratorReport.sha256, 8) }}
                · behavior change: {{ fz.integratorReport.behaviorChange ? 'yes' : 'no' }}
                <template v-if="fz.integratorReport.mismatches?.length"> · mismatches: {{ fz.integratorReport.mismatches.length }}</template>
                <button v-if="fz.integratorReport.artifactId" class="exec-artlink" @click="onOpenArtifact(fz.integratorReport!.artifactId)">view</button>
              </p>
            </div>

            <!-- document result — the accepted work order IS the result -->
            <div v-if="fz.resultKind === 'document' && run.result" class="exec-detail" data-testid="fusion-result-doc">
              <span class="exec-subtitle mono">document result</span>
              <p class="exec-line mono">
                work order {{ (run.result as Record<string, unknown>)?.workOrder && ((run.result as Record<string,unknown>).workOrder as Record<string,unknown>)?.versionId || '—' }}
                — accepted{{ run.result.at ? ` · ${fmtTs(run.result.at)}` : '' }}
              </p>
            </div>
          </template>

          <!-- ============ orchestrator run detail (contract §§4–5) ============ -->
          <template v-if="oz">
            <!-- required actions — the durable pendingActions the run is
                 parked on; each row names the exact decision and carries
                 its control. This is the notification surface. -->
            <div v-if="ozPending.length" class="exec-detail exec-pending" data-testid="orch-actions">
              <span class="exec-subtitle mono">action required</span>
              <div v-for="(a, i) in ozPending" :key="`${a.type}-${i}`" class="exec-actionrow">
                <p class="exec-warn" :data-testid="`orch-pending-${a.type}`">{{ orchPendingActionText(a) }}</p>
                <button
                  v-if="a.type === 'spec_approval'"
                  class="btn primary exec-actionbtn"
                  data-testid="orch-approve-spec"
                  :disabled="gated(orchApproveGate).disabled"
                  :title="gated(orchApproveGate).title || 'Approve this spec version'"
                  @click="onOrchApprove"
                >Approve spec</button>
              </div>
            </div>

            <!-- spec version + acceptance hash -->
            <div class="exec-detail" data-testid="orch-detail">
              <span class="exec-subtitle mono">orchestrator · {{ orchPhaseLabel(oz.phase) }}</span>
              <p v-if="ozSpec" class="exec-line mono" data-testid="orch-spec">
                spec v{{ ozSpec.version ?? '?' }} · {{ ozSpec.status ?? '?' }} · {{ fmtSha(ozSpec.sha256, 12) }}<template v-if="ozSpec.approvedAt"> · approved {{ ozSpec.approvedAt }}</template><template v-if="ozSpec.by"> by {{ ozSpec.by }}</template>
                <button v-if="ozSpec.artifactId" class="exec-artlink" @click="onOpenArtifact(ozSpec.artifactId!)">view</button>
              </p>
              <p v-if="run.acceptance" class="exec-line mono" data-testid="orch-acceptance">
                acceptance hash {{ fmtSha(run.acceptance.resultSha256, 16) }}… · round {{ run.acceptance.round }}
              </p>
              <p v-if="ozIntegrate?.import" class="exec-line mono" data-testid="orch-integrate">
                integrated {{ fmtSha(ozIntegrate.import.commitSha, 8) }} · tree {{ fmtSha(ozIntegrate.import.treeSha, 8) }}<template v-if="ozIntegrate.import.diffStat"> · {{ ozIntegrate.import.diffStat }}</template>
              </p>
              <p v-if="oz.owner" class="exec-line mono" data-testid="orch-owner">
                supervisor claim {{ oz.owner.runnerId }}<template v-if="oz.owner.instanceId">/{{ oz.owner.instanceId }}</template>
              </p>
            </div>

            <!-- subtask graph -->
            <div class="exec-detail" data-testid="orch-tasks">
              <span class="exec-subtitle mono">subtasks<template v-if="ozStats"> · {{ ozStats.accepted ?? 0 }}/{{ ozStats.tasks ?? 0 }} accepted · {{ ozStats.running ?? 0 }} running · {{ ozStats.failed ?? 0 }} failed</template></span>
              <div v-for="t in ozTasks" :key="t.taskId" class="exec-participant mono" :data-testid="`orch-task-${t.taskId}`">
                <span class="exec-pname">{{ t.taskId }} · {{ t.title }}</span>
                <span :data-status="t.status">{{ orchTaskStatusLabel(t.status) }}</span>
                <span v-if="(t.deps ?? []).length" class="exec-pmeta">deps {{ t.deps!.join(', ') }}</span>
                <span v-if="t.profile" class="exec-pmeta">pool {{ t.profile }}</span>
                <span v-if="t.budget" class="exec-pmeta">attempts {{ t.budget.used ?? '?' }}/{{ t.budget.limit ?? '?' }}</span>
                <p v-if="(t.boundary ?? []).length" class="exec-line">boundary: {{ t.boundary!.join(', ') }}</p>
                <p v-if="t.inputCommit" class="exec-line">input {{ fmtSha(t.inputCommit, 8) }}<template v-if="(t.snapshotOf ?? []).length"> · from {{ t.snapshotOf!.join(', ') }}</template></p>
                <p v-if="t.resultCommit" class="exec-line" :data-testid="`orch-result-${t.taskId}`">result {{ fmtSha(t.resultCommit, 8) }} · hash {{ fmtSha(t.resultSha256, 12) }}</p>
                <p v-if="t.evidence" class="exec-line">
                  verdict {{ t.evidence.verdict ?? '—' }}
                  <button v-if="t.evidence.verifyArtifactId" class="exec-artlink" @click="onOpenArtifact(t.evidence.verifyArtifactId!)">verify</button>
                  <button v-if="t.evidence.findingsArtifactId" class="exec-artlink" @click="onOpenArtifact(t.evidence.findingsArtifactId!)">findings</button>
                </p>
                <p v-if="t.waiting" class="exec-line exec-warn" :data-testid="`orch-waiting-${t.taskId}`">
                  waiting: {{ t.waiting.reason ?? '?' }}<template v-if="t.waiting.question"> — {{ t.waiting.question }}</template>
                </p>
                <div v-if="(t.attempts ?? []).length" class="exec-attempts">
                  <div v-for="a in t.attempts!" :key="a.id" class="exec-attempt mono" :data-testid="`orch-attempt-${a.id}`">
                    attempt #{{ a.n }} · {{ a.kind }} · {{ a.status }}<template v-if="a.resultCommit"> · {{ fmtSha(a.resultCommit, 8) }}</template><template v-if="a.error"> · {{ a.error }}</template>
                  </div>
                </div>
                <template v-if="t.status === 'waiting'">
                  <div class="exec-actionrow">
                    <input
                      v-model="orchAnswerDrafts[t.taskId]"
                      class="f-input exec-grow"
                      :data-testid="`orch-answer-${t.taskId}`"
                      placeholder="answer the question…"
                      :disabled="gated(orchAnswerFor(t.taskId)).disabled"
                      @keydown.enter="onOrchAnswer(t.taskId)"
                    />
                    <button
                      class="exec-artlink"
                      :data-testid="`orch-answer-send-${t.taskId}`"
                      :disabled="gated(orchAnswerFor(t.taskId)).disabled"
                      :title="gated(orchAnswerFor(t.taskId)).title"
                      @click="onOrchAnswer(t.taskId)"
                    >answer</button>
                  </div>
                </template>
                <template v-if="t.status === 'failed' || t.status === 'waiting'">
                  <button
                    class="exec-artlink"
                    :data-testid="`orch-grant-${t.taskId}`"
                    :disabled="gated(orchGrantFor(t.taskId)).disabled"
                    :title="gated(orchGrantFor(t.taskId)).title || 'Grant extra attempts'"
                    @click="onOrchGrant(t.taskId)"
                  >grant attempts</button>
                  <!-- retry only while budget remains — canOrchRetry reads
                       budget.used/budget.limit; an exhausted task shows
                       grant alone (the retry POST would be refused). -->
                  <button
                    v-if="t.status === 'failed' && orchRetryFor(t.taskId).ok"
                    class="exec-artlink"
                    :data-testid="`orch-retry-${t.taskId}`"
                    :title="'Re-queue the task within its remaining budget'"
                    @click="onOrchRetry(t.taskId)"
                  >retry</button>
                </template>
              </div>
            </div>
          </template>

          <!-- ============ swarm run detail (contract §§6–7) ============ -->
          <template v-if="sw">
            <!-- required actions -->
            <div v-if="swPending.length" class="exec-detail exec-pending" data-testid="swarm-actions">
              <span class="exec-subtitle mono">action required</span>
              <div v-for="(a, i) in swPending" :key="`${a.type}-${i}`" class="exec-actionrow">
                <p class="exec-warn" :data-testid="`swarm-pending-${a.type}`">{{ swarmPendingActionText(a, run) }}</p>
                <button
                  v-if="a.type === 'extend'"
                  class="btn exec-actionbtn"
                  :data-testid="`swarm-extend-${a.participantId ?? 'all'}`"
                  :disabled="gated(canSwarmExtend(run, a.participantId)).disabled"
                  :title="gated(canSwarmExtend(run, a.participantId)).title || 'Grant extra turns'"
                  @click="onSwarmExtend(a.participantId ?? null)"
                >Extend</button>
              </div>
            </div>

            <!-- freeze banner — apply expectations disabled, reason shown -->
            <p v-if="swFrozen.frozen" class="exec-warn mono" data-testid="swarm-freeze">
              frozen ({{ swFrozen.reason }}) — new edits are held until it clears
            </p>

            <!-- phase + limits -->
            <div class="exec-detail" data-testid="swarm-detail">
              <span class="exec-subtitle mono">swarm · {{ swarmPhaseLabel(sw.phase) }} · round {{ sw.round ?? '—' }}</span>
              <p v-if="swLimits" class="exec-line mono" data-testid="swarm-limits">
                turns {{ swLimits.turnsUsed ?? '?' }}/{{ swLimits.turnsLimit ?? '?' }}
                · round {{ swLimits.round ?? '?' }}/{{ swLimits.maxRounds ?? '?' }}
                · messages {{ swLimits.messagesUsed ?? '?' }}/{{ swLimits.maxMessages ?? '?' }}
              </p>
              <p v-if="run.acceptance" class="exec-line mono" data-testid="swarm-acceptance">
                acceptance hash {{ fmtSha(run.acceptance.resultSha256, 16) }}… · round {{ run.acceptance.round }}
              </p>
              <p v-if="sw.owner" class="exec-line mono" data-testid="swarm-owner">
                broker claim {{ sw.owner.runnerId }}<template v-if="sw.owner.instanceId">/{{ sw.owner.instanceId }}</template>
              </p>
            </div>

            <!-- participants: claims, budget, attempt hash -->
            <div class="exec-detail" data-testid="swarm-participants">
              <span class="exec-subtitle mono">participants</span>
              <div v-for="p in swParticipants" :key="p.participantId" class="exec-participant mono" :data-testid="`swarm-participant-${p.participantId}`">
                <span class="exec-pname">{{ p.callsign ?? p.participantId }} · {{ p.participantId }}</span>
                <span class="exec-pmodel">{{ p.profileId ?? '—' }}</span>
                <span :data-status="p.status">{{ swarmStatusLabel(p.status) }}</span>
                <span v-if="p.budget" class="exec-pmeta">turns {{ p.budget.turnsUsed ?? '?' }}/{{ p.budget.turnsLimit ?? '?' }}</span>
                <span v-if="p.attempt" class="exec-pmeta" :data-testid="`swarm-attempt-${p.participantId}`">attempt {{ p.attempt.status ?? '?' }}<template v-if="p.attempt.porchRunId"> · porch {{ shortId(p.attempt.porchRunId) }}</template></span>
                <p v-if="(p.ownedPaths ?? []).length" class="exec-line">owns: {{ p.ownedPaths!.join(', ') }}</p>
                <p v-if="p.waiting" class="exec-line exec-warn">waiting: {{ p.waiting.reason ?? '?' }}<template v-if="p.waiting.detail"> — {{ p.waiting.detail }}</template></p>
                <div class="exec-actionrow">
                  <input
                    v-model="swarmInputDrafts[p.participantId]"
                    class="f-input exec-grow"
                    :data-testid="`swarm-input-${p.participantId}`"
                    placeholder="steer or answer…"
                    :disabled="gated(canSwarmInput(run, p.participantId)).disabled"
                    @keydown.enter="onSwarmInput(p.participantId)"
                  />
                  <button
                    class="exec-artlink"
                    :data-testid="`swarm-send-${p.participantId}`"
                    :disabled="gated(canSwarmInput(run, p.participantId)).disabled"
                    :title="gated(canSwarmInput(run, p.participantId)).title"
                    @click="onSwarmInput(p.participantId)"
                  >send</button>
                  <button
                    v-if="p.status === 'exhausted'"
                    class="exec-artlink"
                    :data-testid="`swarm-extend-btn-${p.participantId}`"
                    :disabled="gated(canSwarmExtend(run, p.participantId)).disabled"
                    :title="gated(canSwarmExtend(run, p.participantId)).title"
                    @click="onSwarmExtend(p.participantId)"
                  >extend</button>
                </div>
              </div>
              <div class="exec-actionrow">
                <input
                  v-model="swarmBroadcast"
                  class="f-input exec-grow"
                  data-testid="swarm-broadcast"
                  placeholder="broadcast to all participants…"
                  :disabled="gated(canSwarmInput(run, 'all')).disabled"
                  @keydown.enter="onSwarmInput('all')"
                />
                <button
                  class="exec-artlink"
                  data-testid="swarm-broadcast-send"
                  :disabled="gated(canSwarmInput(run, 'all')).disabled"
                  :title="gated(canSwarmInput(run, 'all')).title"
                  @click="onSwarmInput('all')"
                >broadcast</button>
              </div>
            </div>

            <!-- ownership claims -->
            <div v-if="swOwnership.length" class="exec-detail" data-testid="swarm-ownership">
              <span class="exec-subtitle mono">path ownership</span>
              <p v-for="o in swOwnership" :key="`${o.path}-${o.owner}`" class="exec-line mono" :data-contested="String(o.contested === true)">
                {{ o.path }} → {{ o.owner }}<template v-if="o.contested"> · contested</template>
              </p>
            </div>

            <!-- decisions: contested → user settles -->
            <div v-if="swDecisions.length" class="exec-detail" data-testid="swarm-decisions">
              <span class="exec-subtitle mono">decisions</span>
              <div v-for="d in swDecisions" :key="d.id" class="exec-wo mono" :data-testid="`swarm-decision-${d.id}`">
                <p class="exec-line">
                  <strong>{{ d.id }}</strong> · {{ d.kind ?? '?' }} · {{ d.status ?? '?' }}
                  · proposer {{ d.proposer ?? '?' }} · paths {{ (d.paths ?? []).join(', ') || '—' }}
                </p>
                <p v-if="d.rationale" class="exec-line">{{ d.rationale }}</p>
                <template v-if="d.status === 'pending'">
                  <div class="exec-actionrow">
                    <input
                      v-model="swarmDecideNotes[d.id]"
                      class="f-input exec-grow"
                      :data-testid="`swarm-decide-note-${d.id}`"
                      placeholder="note (optional)…"
                    />
                    <button
                      class="btn primary exec-actionbtn"
                      :data-testid="`swarm-decide-approve-${d.id}`"
                      :disabled="gated(canSwarmDecide(run, d.id)).disabled"
                      :title="gated(canSwarmDecide(run, d.id)).title"
                      @click="onSwarmDecide(d.id, 'approve')"
                    >Approve</button>
                    <button
                      class="btn danger exec-actionbtn"
                      :data-testid="`swarm-decide-reject-${d.id}`"
                      :disabled="gated(canSwarmDecide(run, d.id)).disabled"
                      :title="gated(canSwarmDecide(run, d.id)).title"
                      @click="onSwarmDecide(d.id, 'reject')"
                    >Reject</button>
                  </div>
                </template>
              </div>
            </div>

            <!-- message bus -->
            <div v-if="swMessages.length" class="exec-detail" data-testid="swarm-messages">
              <span class="exec-subtitle mono">messages</span>
              <div v-for="m in swMessages" :key="m.id" class="exec-round mono" :data-testid="`swarm-msg-${m.id}`">
                <p class="exec-line">#{{ m.seq ?? '?' }} · {{ m.from ?? '?' }} → {{ m.to ?? '?' }} · {{ m.kind ?? '?' }}</p>
                <p class="exec-ftext">{{ m.text ?? '' }}</p>
              </div>
            </div>

            <!-- findings -->
            <div v-if="swFindings.length" class="exec-detail" data-testid="swarm-findings">
              <span class="exec-subtitle mono">findings</span>
              <div v-for="f in swFindings" :key="f.id" class="exec-finding">
                <span class="exec-fhead mono">
                  <span class="exec-sev" :data-sev="f.severity">{{ f.severity ?? '?' }}</span> {{ f.id }}
                  · owner {{ f.owner ?? '?' }} · {{ f.status ?? '?' }}
                </span>
                <p class="exec-ftext">{{ f.text ?? '' }}</p>
              </div>
            </div>
          </template>

          <!-- recorded result (the descriptor bound at acceptance) -->
          <div v-if="run.result && !isFusion(run) && !isOrchestrator(run) && !isSwarm(run)" class="exec-detail" data-testid="run-result">
            <span class="exec-subtitle mono">result</span>
            <p class="exec-line mono">
              {{ run.result.role }} {{ shortId(run.result.attemptId) }}
              <template v-if="run.result.status"> · {{ run.result.status }}</template>
              <template v-if="run.result.exitCode !== undefined && run.result.exitCode !== null"> · exit {{ run.result.exitCode }}</template>
              <button
                v-if="run.result.finalArtifactId"
                class="exec-artlink"
                @click="onOpenArtifact(run.result.finalArtifactId!)"
              >output</button>
            </p>
            <p v-if="run.result.summary" class="exec-sumtext" data-testid="run-result-summary">{{ run.result.summary }}</p>
          </div>

          <!-- confirmed checks + per-check outcome (report.index binds the
               approved check — stdout/stderr are separate hash-bound logs) -->
          <div v-if="runChecks.length" class="exec-detail" data-testid="run-checks">
            <span class="exec-subtitle mono">checks<template v-if="run.validation?.checks?.verdict"> · {{ run.validation.checks.verdict }}</template></span>
            <div v-for="(c, i) in runChecks" :key="i" class="exec-checkline mono">
              <span class="exec-checkcmd">{{ checkLine(c, i) }}</span>
              <template v-if="reportForIndex(i)">
                <span class="exec-checkrep" :data-status="reportForIndex(i)!.status">
                  → {{ reportForIndex(i)!.status }}<template v-if="reportForIndex(i)!.exitCode !== undefined && reportForIndex(i)!.exitCode !== null"> · exit {{ reportForIndex(i)!.exitCode }}</template>
                </span>
                <button v-if="reportForIndex(i)!.logOutArtifactId" class="exec-artlink" @click="onOpenArtifact(reportForIndex(i)!.logOutArtifactId!)">stdout</button>
                <button v-if="reportForIndex(i)!.logErrArtifactId" class="exec-artlink" @click="onOpenArtifact(reportForIndex(i)!.logErrArtifactId!)">stderr</button>
              </template>
              <span v-else class="exec-checkrep" data-status="missing">→ not recorded</span>
            </div>
          </div>

          <!-- verified findings + verdicts (the docs the gate consumed) -->
          <div v-if="findingsView.length || verdictsDoc" class="exec-detail" data-testid="run-findings">
            <span class="exec-subtitle mono">review findings</span>
            <div v-for="f in findingsView" :key="f.id" class="exec-finding">
              <span class="exec-fhead mono">
                <span class="exec-sev" :data-sev="f.severity">{{ f.severity }}</span> {{ f.id }}
                · {{ f.status }}<template v-if="f.status === 'closed' && f.closedInRound"> in round {{ f.closedInRound }}</template>
                <span v-if="f.verdict" class="exec-verdict" :data-verdict="f.verdict">· checker: {{ f.verdict }}</span>
                <span v-else class="exec-unvetted">· unvetted</span>
              </span>
              <p class="exec-ftext">{{ f.where ? `${f.where} — ` : '' }}{{ f.text }}</p>
            </div>
            <div v-for="v in verdictsDoc?.verdicts ?? []" :key="`v-${v.findingId}-${v.round}`" class="exec-line mono exec-vline">
              verdict {{ v.findingId }}: {{ v.verdict }}<template v-if="v.reason"> — {{ v.reason }}</template>
            </div>
          </div>

          <!-- gate decisions — blocking/nonBlocking/unvetted carry finding
               ids; the text resolves through the verified findings doc -->
          <div v-if="runRounds.length" class="exec-detail" data-testid="run-rounds">
            <span class="exec-subtitle mono">review rounds</span>
            <div v-for="rd in runRounds" :key="rd.round" class="exec-round">
              <p class="exec-line mono">
                round {{ rd.round }} · {{ rd.decision }}<template v-if="rd.checksVerdict"> · checks {{ rd.checksVerdict }}</template>
                <template v-if="rd.resultSha256"> · result {{ fmtSha(rd.resultSha256, 8) }}</template>
                <button v-if="rd.findingsArtifactId" class="exec-artlink" @click="onOpenArtifact(rd.findingsArtifactId)">findings doc</button>
                <button v-if="rd.verdictsArtifactId" class="exec-artlink" @click="onOpenArtifact(rd.verdictsArtifactId)">verdicts doc</button>
              </p>
              <p v-if="rd.reason" class="exec-line exec-warn">{{ rd.reason }}</p>
              <p v-for="id in rd.blocking ?? []" :key="`b-${rd.round}-${id}`" class="exec-line mono exec-blocking">
                blocking {{ id }}<template v-if="roundFindingText(id)"> — {{ roundFindingText(id) }}</template>
              </p>
              <p v-for="id in rd.nonBlocking ?? []" :key="`n-${rd.round}-${id}`" class="exec-line mono">
                reported {{ id }}<template v-if="roundFindingText(id)"> — {{ roundFindingText(id) }}</template>
              </p>
              <p v-for="id in rd.unvetted ?? []" :key="`u-${rd.round}-${id}`" class="exec-line mono exec-unvetted">
                unvetted {{ id }}<template v-if="roundFindingText(id)"> — {{ roundFindingText(id) }}</template>
              </p>
            </div>
          </div>

          <p v-if="run.validation" class="exec-line mono" data-testid="run-validation">
            validation {{ run.validation.status }}<template v-if="run.validation.phase"> · {{ run.validation.phase }}</template>
            <template v-if="run.validation.checks?.verdict"> · checks {{ run.validation.checks.verdict }}</template>
            <template v-if="run.validation.cancel"> · cancel requested</template>
          </p>
          <p v-if="lastRound && lastRound.decision !== 'awaiting_acceptance'" class="exec-line mono" data-testid="run-last-decision">
            last decision: {{ lastRound.decision }}<template v-if="lastRound.reason"> — {{ lastRound.reason }}</template>
          </p>

          <div v-if="run.attempts?.length" class="exec-attempts" data-testid="run-attempts">
            <div v-for="a in run.attempts" :key="a.id" class="exec-attempt mono">
              {{ a.role }}#{{ a.n }} · {{ a.status }}<template v-if="a.phase"> · {{ a.phase }}</template>
              <template v-if="a.finishedAt"> · {{ fmtTs(a.finishedAt) }}</template>
              <span v-if="a.cancel" class="exec-warn"> · cancelling</span>
              <p v-if="a.error" class="art-error">{{ a.error }}</p>
            </div>
          </div>

          <div v-if="runArtifacts.length" class="exec-artifacts" data-testid="run-artifacts">
            <button
              v-for="a in runArtifacts"
              :key="a.id"
              class="art-row mono"
              :title="a.file ?? a.id"
              @click="onOpenArtifact(a.id)"
            >
              <span class="art-name">{{ artifactLabel(a) }}</span>
            </button>
            <pre v-if="openedArtifact" class="exec-docview mono" data-testid="artifact-content">{{ openedArtifact.content }}</pre>
          </div>

          <div class="exec-btnrow">
            <button class="btn" data-testid="open-in-workflow" :disabled="!run" @click="onOpenInWorkflow">
              Show in Workflow panel
            </button>
          </div>

          <!-- full managed event history — every event the store drained,
               each expandable to its recorded payload (shared component) -->
          <ManagedRunEvents
            v-if="st.events.length || st.eventsPending"
            :events="st.events"
            :pending="st.eventsPending"
            :corrupt="st.eventsCorrupt"
            :total="st.eventsTotal"
          />
        </template>
        <p v-else-if="st.runError" class="art-error">{{ st.runError }}</p>

        <!-- run history -->
        <div v-if="view.runs.length" class="exec-history" data-testid="run-history">
          <div
            v-for="r in [...view.runs].reverse()"
            :key="r.id"
            class="exec-histrow mono"
            :class="{ sel: st.selectedRunId === r.id }"
            role="button"
            tabindex="0"
            @click="exec.selectRun(props.cardId, r.id)"
            @keydown.enter="exec.selectRun(props.cardId, r.id)"
          >
            {{ shortId(r.id) }} · {{ runStatusLabel(r.status) }}
            <span v-if="r.mode && r.mode !== 'solo'" class="exec-mode" :title="`${r.mode} run`">{{ r.mode }}</span>
            <span v-if="r.pending" class="exec-pending-badge" title="this run is waiting on a user decision">needs you</span>
            <span v-if="r.reserved" class="exec-warn" title="a live attempt or unproven validation still reserves this run">reserved</span>
            <span v-if="r.id === view.currentRunId" class="exec-current">current</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.exec-panel {
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
.exec-doc-tabs {
  display: flex;
  gap: 0.125rem;
}
.exec-doc-tabs .tab-btn {
  padding: 0 0.375rem;
  min-height: 22px;
  font-size: 0.625rem;
}
.exec-line {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
  margin: 0;
}
.exec-select {
  font-size: 0.6875rem;
}
.exec-btnrow {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.exec-btn {
  align-self: flex-start;
}
.exec-warn {
  color: var(--text-accent, #c2532f);
  font-size: 0.6875rem;
}
.exec-dismiss {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0 0.25rem;
}
.exec-editor {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.exec-area {
  font-size: 0.6875rem;
}
.exec-importrow .f-input {
  width: 100%;
  font-size: 0.6875rem;
}
.exec-docview {
  max-height: 14rem;
  overflow: auto;
  font-size: 0.625rem;
  white-space: pre-wrap;
  margin: 0;
  padding: 0.375rem;
  background: var(--bg-main, #fbf8f3);
  border-radius: var(--radius-sm, 4px);
}
.exec-checks {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.check-editrow {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.check-editrow .f-input {
  font-size: 0.6875rem;
}
.check-cwd {
  width: 5.5rem;
}
.check-tmo {
  width: 3.5rem;
}
.check-setup {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
}
.exec-member {
  display: grid;
  grid-template-columns: 5.5rem 1fr 1fr;
  gap: 0.25rem;
  align-items: center;
}
.exec-member .f-input {
  font-size: 0.6875rem;
  min-width: 0;
}
.exec-member .f-input[aria-label$="params"] {
  grid-column: 2 / -1;
}
.exec-role {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-limits {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-limits label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.exec-num {
  width: 3.5rem;
  font-size: 0.6875rem;
}
.exec-startrow {
  display: flex;
  gap: 0.375rem;
  align-items: center;
}
.exec-startrow .f-input {
  flex: 1;
  font-size: 0.6875rem;
}
.exec-detail {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.exec-subtitle {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--text-secondary, #6b6259);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.exec-checkline {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-checkrep {
  color: var(--text-primary, #2b2723);
}
.exec-checkrep[data-status='failed'],
.exec-checkrep[data-status='error'],
.exec-checkrep[data-status='fail'],
.exec-checkrep[data-status='missing'] {
  color: var(--text-accent, #c2532f);
}
.exec-sev[data-sev='critical'],
.exec-sev[data-sev='major'] {
  color: var(--text-accent, #c2532f);
  font-weight: 600;
}
.exec-verdict[data-verdict='rejected'] {
  color: var(--text-secondary, #6b6259);
}
.exec-verdict[data-verdict='confirmed'],
.exec-verdict[data-verdict='disputed'] {
  color: var(--text-accent, #c2532f);
}
.exec-unvetted {
  color: var(--text-accent, #c2532f);
}
.exec-blocking {
  color: var(--text-accent, #c2532f);
}
.exec-ftext {
  margin: 0 0 0 0.5rem;
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
  white-space: pre-wrap;
}
.exec-fhead {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-sumtext {
  margin: 0;
  font-size: 0.625rem;
  color: var(--text-primary, #2b2723);
  white-space: pre-wrap;
}
.exec-vline {
  padding-left: 0.5rem;
}
.exec-artlink {
  border: none;
  background: transparent;
  color: var(--text-accent, #c2532f);
  font-family: inherit;
  font-size: 0.625rem;
  cursor: pointer;
  padding: 0 0.25rem;
  text-decoration: underline;
}
.exec-round {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-attempts {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.exec-attempt {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-attempt .art-error {
  margin: 0;
}
.exec-artifacts {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.exec-history {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.exec-histrow {
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
  padding: 0.125rem 0.25rem;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}
.exec-histrow:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}
.exec-histrow.sel {
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
}
.exec-current {
  color: var(--text-accent, #c2532f);
}
/* F4 fusion */
.exec-pending {
  padding: 0.375rem;
  border: 1px solid var(--text-accent, #c2532f);
  border-radius: var(--radius-sm, 4px);
  background: var(--accent-soft, rgba(194, 83, 47, 0.08));
}
.exec-actionrow {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.exec-actionrow .exec-warn {
  margin: 0;
  flex: 1;
  min-width: 12rem;
}
.exec-actionbtn {
  flex: none;
}
.exec-members {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.exec-member4 {
  grid-template-columns: 5.5rem 1fr auto;
}
.exec-member-swarm {
  grid-template-columns: 2.5rem 4rem 1fr 1fr auto;
}
.exec-cs {
  text-align: center;
}
.exec-participant {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: baseline;
  font-size: 0.625rem;
  color: var(--text-secondary, #6b6259);
}
.exec-participant .exec-pname {
  color: var(--text-primary, #2b2723);
  font-weight: 600;
}
.exec-participant [data-status='answered'] {
  color: var(--text-primary, #2b2723);
}
.exec-participant [data-status='awaiting_decision'] {
  color: var(--text-accent, #c2532f);
  font-weight: 600;
}
.exec-participant [data-status='excluded'] {
  color: var(--text-secondary, #6b6259);
  text-decoration: line-through;
}
.exec-pmodel,
.exec-pmeta {
  color: var(--text-secondary, #6b6259);
}
.exec-participant .exec-line {
  width: 100%;
  margin: 0;
}
.exec-wo {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}
.exec-wo .exec-artlink {
  margin-left: 0.25rem;
}
.exec-mode {
  color: var(--text-accent, #c2532f);
  border: 1px solid var(--text-accent, #c2532f);
  border-radius: var(--radius-sm, 4px);
  padding: 0 0.25rem;
  font-size: 0.5625rem;
}
.exec-pending-badge {
  color: #fff;
  background: var(--text-accent, #c2532f);
  border-radius: var(--radius-sm, 4px);
  padding: 0 0.25rem;
  font-size: 0.5625rem;
}
.exec-grow {
  flex: 1;
  min-width: 0;
}
</style>
