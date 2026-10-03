// Managed execution store (U6): the typed user-channel view of
// server/execution/state-service.mjs. Polling is ref-counted per card —
// CardDrawer watches the open card, the Workflow panel watches the focused
// card; unwatching stops fetches for that card.
//
// Concurrency rules:
//  - every request carries a monotonic issue stamp; a response may only
//    adopt state or flip `online` when no NEWER request was issued since —
//    an old slow GET can never roll state or connectivity backwards.
//  - `seq` is the per-card watch generation (bumped on unwatch). `reqSeq`
//    orders refreshCard calls; `runReqSeq` orders run-detail/event calls
//    (also bumped by selectRun). A response checks all applicable guards
//    before touching state.
//  - commands are NEVER queued for later and NEVER retried automatically:
//    one deliberate click = one commandId = one POST. The per-card `busy`
//    flag is acquired before the first await, so two clicks cannot issue
//    two different commandIds.
//  - every managed-card command carries expectedControlRevision from a
//    refresh performed while the busy flag is held; a failed refresh
//    refuses the POST — a cached "ready" view is never command authority.
//  - unwatching a card drops its entry entirely; a response arriving for
//    the dropped object is discarded (`cards[cardId] !== st`).
//  - run detail/events come from the run's own endpoints; the card view's
//    `reserved` flag is authoritative for live-work gating.

import { defineStore } from 'pinia';
import { computed, markRaw, ref } from 'vue';
import {
  ExecApiError,
  ExecClient,
  execClient,
  type ExecCardSummary,
  type ExecCardView,
  type ExecCompatibility,
  type ExecCommandType,
  type ExecDocVersionContent,
  type ExecPrepView,
  type ExecPreset,
  type ExecPresetInput,
  type ExecRun,
  type ExecRunEvent,
  type ExecArtifactContent,
  type PrepBindingInfo,
} from '../lib/execution/api.ts';
import { RUN_LIVE_STATUSES } from '../lib/execution/ui-model.ts';
import { useBoardStore } from './board';
import { uuid } from '../lib/uuid';

const POLL_MS = 2000;
const EVENTS_PAGE = 200;
/** Max event pages drained per refreshRun — a terminal run with a long
 * history converges over a few polls instead of one unbounded read. */
const EVENTS_MAX_PAGES = 10;

export type CardPhase = 'idle' | 'loading' | 'ready' | 'unmanaged' | 'error';

export interface CommandOutcome {
  ok: boolean;
  code?: string;
  error?: string;
  status?: number;
  result?: unknown;
  details?: Record<string, unknown>;
}

export interface CardExecState {
  cardId: string;
  phase: CardPhase;
  view: ExecCardView | null;
  /** Last user-facing fetch/command error for this card. */
  error: string | null;
  lastFetchedAt: number | null;
  watchers: number;
  /** Watch generation — bumped when the entry is dropped. */
  seq: number;
  /** Latest refreshCard request id — newest issued wins. */
  reqSeq: number;
  /** Latest run request id — bumped by selectRun and each refreshRun. */
  runReqSeq: number;
  /** internalRevision at the last successful board.json managed-row sync. */
  syncedInternalRev: number;
  /** Run the detail pane shows (defaults to the card's current run). */
  selectedRunId: string | null;
  /** currentRunId seen on the previous adopt — auto-follows continue. */
  lastCurrentRunId: string | null;
  run: ExecRun | null;
  runError: string | null;
  events: ExecRunEvent[];
  eventsCursor: number;
  eventsTotal: number;
  eventsCorrupt: number;
  /** The events file still has pages past the cursor — keep polling it. */
  eventsPending: boolean;
  /** Command type currently in flight (busy-guard for double clicks). */
  busy: ExecCommandType | null;
  commandError: { code: string; error: string; at: number } | null;
  /** Single-flight refreshCard promise — later callers coalesce. Stored
   * markRaw so identity comparison survives the reactive proxy. */
  cardInflight: Promise<boolean> | null;
  /** Token identifying the in-flight run refresh — carries its runId; a
   * same-run call coalesces, a different selection starts its own, and an
   * A→B→A old response can never clear the new A's flight (markRaw — the
   * token identity must survive reactivity). */
  runInflight: { runId: string } | null;
  /** P5: the full preparation session view — fetched on the same poll as
   * the card whenever the server advertises features.preparation; null when
   * there is no session or the feature is off. Never fabricated: a fetch
   * error keeps the last view AND records prepError so the panel marks it
   * stale. */
  preparation: ExecPrepView | null;
  prepError: string | null;
}

function freshState(cardId: string): CardExecState {
  return {
    cardId,
    phase: 'idle',
    view: null,
    error: null,
    lastFetchedAt: null,
    watchers: 0,
    seq: 0,
    reqSeq: 0,
    runReqSeq: 0,
    syncedInternalRev: -1,
    selectedRunId: null,
    lastCurrentRunId: null,
    run: null,
    runError: null,
    events: [],
    eventsCursor: 0,
    eventsTotal: 0,
    eventsCorrupt: 0,
    eventsPending: false,
    busy: null,
    commandError: null,
    cardInflight: null,
    runInflight: null,
    preparation: null,
    prepError: null,
  };
}

// Test seam: the store reads through `clientOf()` so node tests can inject
// a stubbed ExecClient without touching global fetch.
let _client: ExecClient | null = null;
function clientOf(): ExecClient {
  if (!_client) _client = execClient();
  return _client;
}
export function setExecutionClient(client: ExecClient | null): void {
  _client = client;
}

export const useExecutionStore = defineStore('execution', () => {
  const cards = ref<Record<string, CardExecState>>({});
  /** null = not probed yet; false = state server unreachable. Commands are
   * disabled while false. */
  const online = ref<boolean | null>(null);
  const presets = ref<ExecPreset[]>([]);
  const presetsRev = ref<number | null>(null);
  /** Server-provided per-CLI compatibility table — the ONLY source for
   * model/effort/params choices (no frontend-side allowlist). */
  const compatibility = ref<ExecCompatibility | null>(null);
  const compatError = ref<string | null>(null);
  const presetsError = ref<string | null>(null);
  const presetsLoaded = ref(false);
  /** Managed run currently pinned in the Workflow side panel. */
  const focused = ref<{ cardId: string; runId: string } | null>(null);
  /** Managed card inventory from GET /execution/cards (summaries only —
   * no full views; a summary never substitutes for a card GET). */
  const managedIndex = ref<ExecCardSummary[]>([]);
  const indexError = ref<string | null>(null);
  /** P5: the bindable skill routes (GET /execution/preparation/bindings) —
   * shared across cards; null = not loaded yet / feature off. */
  const prepBindings = ref<PrepBindingInfo[] | null>(null);
  const prepPi = ref<{ binary: string; version: string } | null>(null);
  const prepBindingsError = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  /** Monotonic issue stamp for `online` writes — the response of the
   * most recently issued request decides connectivity. */
  let netCounter = 0;
  let netDecidedBy = 0;

  // ---- bookkeeping ---------------------------------------------------------------

  function stateFor(cardId: string): CardExecState {
    if (!cards.value[cardId]) {
      cards.value[cardId] = freshState(cardId);
    }
    // Always return the REACTIVE view of the entry — never the raw object
    // captured before insertion. A computed that caches the raw object
    // tracks no deps on it: later `.run`/`.view` writes through the proxy
    // would never re-trigger `run = computed(() => st.value.run)`.
    return cards.value[cardId];
  }

  /** Entry dropped (unwatch) or generation bumped — nothing may adopt. */
  function alive(st: CardExecState): boolean {
    return cards.value[st.cardId] === st && st.watchers > 0;
  }

  function issueNet(): number {
    return ++netCounter;
  }

  function noteNet(okResult: boolean, issued: number): void {
    // Only a newer-issued request may change connectivity — an old slow
    // failure must not flip a healed link back to offline.
    if (issued > netDecidedBy) {
      online.value = okResult;
      netDecidedBy = issued;
    }
  }

  function asErr(e: unknown): ExecApiError {
    return e instanceof ExecApiError ? e : new ExecApiError(0, null, String(e));
  }

  // ---- card view -------------------------------------------------------------

  /** GET the card and adopt it. Returns true only when a FRESH view was
   * adopted for this exact card — callers (sendCommand) must treat false
   * as "no authority to act". Single-flight: a second call while a GET is
   * in flight coalesces onto the same request so a slow response can
   * never be starved out by later polls. */
  async function refreshCard(cardId: string): Promise<boolean> {
    const st = cards.value[cardId];
    if (!st || st.watchers === 0) return false;
    if (st.cardInflight) return st.cardInflight;
    const p = doRefreshCard(st);
    const tracked = p.finally(() => {
      if (st.cardInflight === tracked) st.cardInflight = null;
    });
    st.cardInflight = markRaw(tracked);
    return tracked;
  }

  async function doRefreshCard(st: CardExecState): Promise<boolean> {
    const cardId = st.cardId;
    const seq = st.seq;
    const reqSeq = ++st.reqSeq;
    const net = issueNet();
    let view: ExecCardView;
    try {
      view = await clientOf().getCard(cardId);
    } catch (e) {
      const err = asErr(e);
      noteNet(err.status !== 0, net);
      if (!alive(st) || st.seq !== seq || st.reqSeq !== reqSeq) return false;
      if (err.isCardNotFound) {
        // Not managed (or the aggregate is gone) — the local marker is
        // stale and must be cleared, never kept alive from cached state.
        st.phase = 'unmanaged';
        st.view = null;
        st.error = null;
        useBoardStore().clearManagedProjection(cardId);
        return false;
      }
      st.error = err.message;
      if (st.phase === 'idle') st.phase = 'error';
      return false;
    }
    noteNet(true, net);
    if (!alive(st) || st.seq !== seq || st.reqSeq !== reqSeq) return false;
    const prevCurrent = st.lastCurrentRunId;
    st.view = view;
    st.phase = 'ready';
    st.error = null;
    st.lastFetchedAt = Date.now();
    st.lastCurrentRunId = view.currentRunId;

    // P5: the preparation session view rides the card poll — fetched only
    // while the server advertises the feature. A 404 (no session) or 501
    // (feature off) converges to null; any other failure keeps the last
    // view and marks it stale via prepError — a rendered stale discussion
    // beats a blank one, but it is never presented as authoritative.
    if (view.features?.preparation === true) {
      try {
        const prep = await clientOf().getPreparation(cardId);
        if (!alive(st) || st.seq !== seq || st.reqSeq !== reqSeq) return false;
        st.preparation = prep?.preparation ?? null;
        st.prepError = null;
      } catch (e) {
        const err = asErr(e);
        if (!alive(st) || st.seq !== seq || st.reqSeq !== reqSeq) return false;
        if (err.status === 404 || err.status === 501) {
          st.preparation = null;
          st.prepError = null;
        } else {
          st.prepError = err.message;
        }
      }
    } else if (st.preparation !== null || st.prepError !== null) {
      st.preparation = null;
      st.prepError = null;
    }

    const board = useBoardStore();
    board.applyManagedProjection(view);
    // The card view exposes only {stage,status}; the full managed row
    // (flags/project/session/order/marker) lives in board.json — sync it
    // whenever the aggregate's internal revision moved since our last
    // successful adoption. The sync is a read, never a board write.
    if (view.internalRevision !== st.syncedInternalRev) {
      const synced = await board.syncManagedRows();
      if (!alive(st) || st.seq !== seq || st.reqSeq !== reqSeq) return false;
      if (synced) st.syncedInternalRev = view.internalRevision;
    }

    // Two separate decisions, in order:
    //  1) auto-follow: the selection tracks the card's current run unless
    //     the user deliberately pinned a historical one (or the pinned run
    //     vanished) — `continue` moves the pane to the new run.
    //  2) detail freshness: whatever is selected gets its run record +
    //     events refetched when the summary moved — including the terminal
    //     transition where the final report/status lands.
    const pick = st.selectedRunId;
    const pinIsLive = !!pick && view.runs.some((r) => r.id === pick);
    const followsCurrent = !pick || pick === prevCurrent || !pinIsLive;
    const next = view.currentRunId ?? view.runs[view.runs.length - 1]?.id ?? null;
    if (followsCurrent && next !== pick) {
      void selectRun(cardId, next);
      return true;
    }
    const sel = st.selectedRunId;
    const sum = sel ? view.runs.find((r) => r.id === sel) : null;
    if (sel && sum) {
      const needsDetail =
        !st.run || // never loaded
        st.run.id !== sel ||
        st.run.status !== sum.status || // status transition (e.g. active→succeeded)
        sum.reserved === true || // live reservation — attempts/validation move
        RUN_LIVE_STATUSES.has(sum.status ?? '') ||
        st.eventsPending; // history pages still owed
      if (needsDetail) void refreshRun(cardId);
    }
    return true;
  }

  // ---- run detail + events -----------------------------------------------------

  async function selectRun(cardId: string, runId: string | null): Promise<void> {
    const st = stateFor(cardId);
    if (st.selectedRunId === runId && st.run) return;
    st.selectedRunId = runId;
    st.run = null;
    st.runError = null;
    st.events = [];
    st.eventsCursor = 0;
    st.eventsTotal = 0;
    st.eventsCorrupt = 0;
    st.eventsPending = false;
    st.runReqSeq += 1; // invalidate any in-flight detail/events response
    if (runId) await refreshRun(cardId);
  }

  /** GET the selected run's full record + drain its event pages (bounded).
   * Single-flight per selection: while a refresh for this exact run is in
   * flight a later call coalesces (returns immediately) — a 2s poll can
   * never starve a slower read out via token supersession. A NEW selection
   * bumps runReqSeq so the old response dies and its own refresh starts. */
  async function refreshRun(cardId: string): Promise<void> {
    const st = cards.value[cardId];
    const runId = st?.selectedRunId;
    if (!st || !runId) return;
    if (st.runInflight && st.runInflight.runId === runId) return;
    const flight = markRaw({ runId });
    st.runInflight = flight;
    try {
      const reqSeq = ++st.runReqSeq;
      const net = issueNet();
      const current = () =>
        alive(st) && st.selectedRunId === runId && st.runReqSeq === reqSeq;
      try {
        const run = await clientOf().getRun(runId);
        noteNet(true, net);
        if (!current()) return;
        st.run = run;
        st.runError = null;
      } catch (e) {
        const err = asErr(e);
        noteNet(err.status !== 0, net);
        if (!current()) return;
        st.runError = err.message;
        return;
      }
      // Incremental event drain: the cursor is the canonical next-seq; the
      // server dedups malformed/duplicate lines itself. Older responses
      // are impossible here — runReqSeq is checked after every await.
      let pages = 0;
      let remaining = 0;
      while (current() && pages < EVENTS_MAX_PAGES) {
        let page;
        try {
          page = await clientOf().getRunEvents(runId, st.eventsCursor, EVENTS_PAGE);
        } catch {
          // Transient read failure — the history is NOT drained; keep the
          // retryable marker so the next poll resumes from the same cursor.
          // Without it a terminal run whose first read failed would never
          // show its history again.
          remaining = 1;
          break;
        }
        pages += 1;
        if (!current()) return;
        for (const ev of page.events) {
          if (!st.events.some((e) => e.seq === ev.seq)) st.events.push(ev);
        }
        st.eventsCursor = Math.max(st.eventsCursor, page.nextCursor);
        st.eventsTotal = page.total;
        st.eventsCorrupt = page.corrupt;
        remaining = page.remaining;
        if (!page.remaining || !page.events.length) break;
      }
      if (current()) st.eventsPending = remaining > 0;
    } finally {
      if (st.runInflight === flight) st.runInflight = null;
    }
  }

  function getDocument(cardId: string, versionId: string): Promise<ExecDocVersionContent> {
    return clientOf().getDocument(cardId, versionId);
  }

  function getArtifact(runId: string, artifactId: string): Promise<ExecArtifactContent> {
    return clientOf().getArtifact(runId, artifactId);
  }

  // ---- commands ------------------------------------------------------------------

  /**
   * One deliberate user action. The busy flag is acquired BEFORE the first
   * await so two clicks can never mint two commandIds. The command POSTs
   * only when a fresh GET succeeded while the flag was held — a cached
   * ready view is never authority — and only while this exact state entry
   * is still watched (a closed drawer issues nothing). Failures surface
   * the server code/message and converge via an authoritative refresh.
   */
  async function sendCommand(
    cardId: string,
    type: ExecCommandType,
    payload: Record<string, unknown> = {},
  ): Promise<CommandOutcome> {
    const st = stateFor(cardId);
    if (st.busy) {
      return { ok: false, code: 'busy', error: 'a command is still in flight — wait a moment' };
    }
    st.busy = type;
    st.commandError = null;
    const gen = st.seq;
    const stillMine = () => cards.value[cardId] === st && st.seq === gen;
    let net = 0; // request issue stamp — set immediately before the POST
    try {
      // Every command — including enable — is grounded in a fresh read
      // while the busy flag is held. `refreshCard` returns false both on
      // transport failure AND on a fresh "not managed" (404) answer; the
      // phase tells them apart below.
      const fresh = await refreshCard(cardId);
      if (!stillMine()) {
        return { ok: false, code: 'stale', error: 'the card view changed while checking state' };
      }
      if (type === 'enable') {
        if (st.phase === 'ready' && st.view?.managed) {
          return { ok: false, code: 'already_managed', error: 'this card is already managed' };
        }
        if (st.phase !== 'unmanaged') {
          return {
            ok: false,
            code: 'offline',
            error: st.error ?? 'the state server is unreachable — actions are disabled',
          };
        }
      } else if (!fresh || st.phase !== 'ready' || !st.view) {
        return {
          ok: false,
          code: st.phase === 'unmanaged' ? 'card_not_found' : 'offline',
          error:
            st.phase === 'unmanaged'
              ? 'this card is not managed'
              : st.error ?? 'the state server is unreachable — actions are disabled',
        };
      }
      const envelope = {
        commandId: `uc_${uuid()}`,
        type,
        payload,
        ...(type === 'enable' ? {} : { expectedControlRevision: st.view?.controlRevision ?? 0 }),
      };
      net = issueNet(); // stamped BEFORE the POST lands
      const res = await clientOf().sendCommand(cardId, envelope);
      noteNet(true, net);
      if (stillMine()) void refreshCard(cardId);
      return { ok: true, result: res.result };
    } catch (e) {
      const err = asErr(e);
      // The POST's own stamp was issued before it left — an older
      // in-flight read can't flip a healed link back to offline, and a
      // dropped entry reports nothing.
      if (stillMine()) noteNet(err.status !== 0, net);
      if (stillMine()) {
        st.commandError = { code: err.code, error: err.message, at: Date.now() };
        // Non-transport failures are recorded server-side or leave state
        // inconsistent — always converge on the authoritative card view.
        if (err.status !== 0) void refreshCard(cardId);
      }
      return {
        ok: false,
        code: err.code,
        error: err.message,
        status: err.status,
        details: err.details,
      };
    } finally {
      if (cards.value[cardId] === st) st.busy = null;
    }
  }

  function clearCommandError(cardId: string): void {
    const st = cards.value[cardId];
    if (st) st.commandError = null;
  }

  // ---- presets -------------------------------------------------------------------

  async function loadPresets(): Promise<void> {
    const net = issueNet();
    try {
      const res = await clientOf().listPresets();
      noteNet(true, net);
      presets.value = res.presets ?? [];
      presetsRev.value = typeof res.rev === 'number' ? res.rev : null;
      compatibility.value = res.compatibility ?? null;
      compatError.value = res.compatError ?? null;
      presetsError.value = null;
      presetsLoaded.value = true;
    } catch (e) {
      const err = asErr(e);
      noteNet(err.status !== 0, net);
      presetsError.value = err.message;
    }
  }

  async function savePresetEntry(
    preset: ExecPresetInput,
    editingId: string | null,
  ): Promise<CommandOutcome> {
    const net = issueNet();
    try {
      if (editingId) {
        await clientOf().updatePreset(editingId, preset, presetsRev.value);
      } else {
        await clientOf().createPreset(preset);
      }
      await loadPresets();
      return { ok: true };
    } catch (e) {
      const err = asErr(e);
      noteNet(err.status !== 0, net);
      // A stale registry rev is recoverable — reload the registry so the
      // editor shows fresh state, then surface the conflict to the user.
      if (err.isRevConflict) await loadPresets();
      return { ok: false, code: err.code, error: err.message, status: err.status, details: err.details };
    }
  }

  async function removePreset(presetId: string): Promise<CommandOutcome> {
    const net = issueNet();
    try {
      await clientOf().deletePreset(presetId);
      await loadPresets();
      return { ok: true };
    } catch (e) {
      const err = asErr(e);
      noteNet(err.status !== 0, net);
      return { ok: false, code: err.code, error: err.message, status: err.status };
    }
  }

  // ---- managed card index (Workflow panel) ----------------------------------------

  async function refreshIndex(): Promise<void> {
    const net = issueNet();
    try {
      const res = await clientOf().listCards();
      noteNet(true, net);
      managedIndex.value = res.cards ?? [];
      indexError.value = null;
    } catch (e) {
      const err = asErr(e);
      noteNet(err.status !== 0, net);
      indexError.value = err.message;
    }
  }

  // ---- preparation binding registry ---------------------------------------------

  /** Load the bindable-skill listing once; `force` re-reads after a
   * mutation (a binding change can repin digests). Errors surface on
   * prepBindingsError — never a silent empty list (the UI distinguishes
   * "no routes registered" from "registry unreadable"). */
  async function loadPrepBindings(force = false): Promise<void> {
    if (prepBindings.value !== null && !force) return;
    const net = issueNet();
    try {
      const res = await clientOf().getPreparationBindings();
      noteNet(true, net);
      prepBindings.value = res.bindings ?? [];
      prepPi.value = res.pi ?? null;
      prepBindingsError.value = null;
    } catch (e) {
      const err = asErr(e);
      noteNet(err.status !== 0, net);
      prepBindingsError.value = err.message;
    }
  }

  // ---- watching / polling ------------------------------------------------------------

  function ensureTimer(): void {
    if (timer !== null) return;
    timer = setInterval(() => void tick(), POLL_MS);
  }

  function watchCard(cardId: string): void {
    const st = stateFor(cardId);
    st.watchers += 1;
    if (st.phase === 'idle' || st.phase === 'error') void refreshCard(cardId);
    ensureTimer();
  }

  function unwatchCard(cardId: string): void {
    const st = cards.value[cardId];
    if (!st) return;
    st.watchers = Math.max(0, st.watchers - 1);
    if (st.watchers === 0) {
      // Drop the entry entirely — a re-watch starts from a clean slate and
      // in-flight responses die with the bumped generation + dead object.
      st.seq += 1;
      delete cards.value[cardId];
      if (focused.value?.cardId === cardId) focused.value = null;
    }
    if (!Object.values(cards.value).some((c) => c.watchers > 0)) stopPolling();
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const ids = Object.values(cards.value)
        .filter((c) => c.watchers > 0)
        .map((c) => c.cardId);
      for (const id of ids) {
        await refreshCard(id);
      }
      // The managed index only matters while the workflow panel shows it —
      // poll it whenever the focus feature is engaged.
      if (focused.value) void refreshIndex();
    } finally {
      ticking = false;
    }
  }

  function startPolling(): void {
    ensureTimer();
    void tick();
  }

  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ---- workflow focus ---------------------------------------------------------------

  /** Pin a managed run in the Workflow side panel. The focus holds exactly
   * one watch on its card: re-focusing the same run is a no-op, a
   * different card releases the previous focus's watch first, and
   * clearFocus() balances it. Component watchers are separate refcounts. */
  function openManagedRun(cardId: string, runId: string | null): void {
    const prev = focused.value;
    if (prev && prev.cardId === cardId && prev.runId === runId) return;
    if (runId) {
      // The focus owns exactly one watch on its card — moving between runs
      // of the SAME card keeps it, moving to a different card swaps it.
      if (!prev || prev.cardId !== cardId) watchCard(cardId);
      focused.value = { cardId, runId };
      void selectRun(cardId, runId);
      if (prev && prev.cardId !== cardId) unwatchCard(prev.cardId);
    } else {
      focused.value = null;
      if (prev) unwatchCard(prev.cardId);
    }
  }

  function clearFocus(): void {
    openManagedRun('', null);
  }

  // ---- derived ---------------------------------------------------------------------

  const watchedCount = computed(
    () => Object.values(cards.value).filter((c) => c.watchers > 0).length,
  );

  return {
    cards,
    online,
    presets,
    presetsRev,
    compatibility,
    compatError,
    presetsError,
    presetsLoaded,
    managedIndex,
    indexError,
    prepBindings,
    prepPi,
    prepBindingsError,
    loadPrepBindings,
    focused,
    watchedCount,
    stateFor,
    watchCard,
    unwatchCard,
    refreshCard,
    refreshRun,
    selectRun,
    sendCommand,
    clearCommandError,
    getDocument,
    getArtifact,
    loadPresets,
    savePresetEntry,
    removePreset,
    refreshIndex,
    startPolling,
    stopPolling,
    openManagedRun,
    clearFocus,
  };
});
