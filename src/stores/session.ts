// Session store: orchestrates open session tabs and owns the sidebar
// inventory. Each open tab is a SessionRuntime (its own ACP connection,
// transcript, permission state) — this store decides which tab is active,
// persists the open set, and delegates the legacy single-session API
// surface to the active runtime so existing callers keep working.
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { trackEvent } from '../lib/telemetry';
import { uuid } from '../lib/uuid';
import type { SavedSession, AgentConfig } from '../lib/types';
import { loadAttachmentHistory, forgetSessionAttachments } from '../lib/attachmentHistory';
import { evictHistoryCaches } from '../lib/historyCache';
import {
  createSessionRuntime,
  initializeHandshake,
  initRuntimeVersion,
  setPermissionTimeoutMs,
  PERMISSION_TIMEOUT_MS,
  type SessionRuntime,
  type SessionTab,
} from '../lib/sessionRuntime';
import { AcpClientBridge, createAcpClient } from '../lib/acp-bridge';
import { setSessionInUrl } from '../lib/sessionUrl';
import { useConfigStore } from './config';
import type { AuthMethod, SessionInfo } from '@agentclientprotocol/sdk';

const STORE_PATH = 'sessions.json';

/**
 * `session/list` is cursor-paginated and the agent picks the page size
 * (Hermes caps at 50). Cap the loop so a misbehaving agent that returns the
 * same cursor forever can't spin the client: at 20 pages we surface what we
 * have and stop.
 */
const MAX_SESSION_LIST_PAGES = 20;

/** Persisted pointer to one open tab (the session it will resume). */
interface StoredTab {
  agentName: string;
  sessionId: string;
}

export const useSessionStore = defineStore('session', () => {
  // ---- Sidebar inventory -------------------------------------------------
  const savedSessions = ref<SavedSession[]>([]);
  // ---- Open tabs ----------------------------------------------------------
  // Items read back through this reactive array are deep-unwrapped proxies
  // (SessionTab): ref fields surface as plain values.
  const openTabs = ref<SessionTab[]>([]);
  const activeTabId = ref<string | null>(null);
  /** Tabs read from sessions.json at boot; consumed by `restoreTabs`. */
  let storedTabs: StoredTab[] = [];
  let storedActiveTab: StoredTab | null = null;

  /** Error shown when no tab is active (welcome screen, failed restores). */
  const orphanError = ref<string | null>(null);

  // Authentication state — one dialog at a time; concurrent requests from
  // parallel tab connects queue up and are shown in order.
  const pendingAuthMethods = ref<AuthMethod[]>([]);
  const pendingAuthAgentName = ref<string>('');
  let authQueue: {
    methods: AuthMethod[];
    agentName: string;
    resolve: (methodId: string | null) => void;
  }[] = [];

  // ---- Agent-side session inventory (`session/list`) -----------------------
  // The agent owns its history; this client mirrors the metadata into the
  // sidebar so sessions created elsewhere (CLI, Telegram, another device)
  // show up here and can be resumed. The sidebar lists ALL agents' sessions
  // merged — there is no per-agent scope any more.
  const isSyncingSessions = ref(false);
  const syncError = ref<string | null>(null);
  /**
   * Agents that answered initialize without the `session/list` capability.
   * Tracked per agent — a merged list can't carry one global flag. Known only
   * after a sync attempt, so the UI hides the refresh affordance rather than
   * offering a button that can never work.
   */
  const listUnsupportedAgents = ref<string[]>([]);
  /** Agent of the most recent connection — prefill for the new-session menu. */
  const lastAgentName = ref('');
  /**
   * `${agentName}::${sessionId}` keys the user removed from the sidebar while
   * the agent still holds them. Persisted, because otherwise the next sync
   * would resurrect every deleted row and make Delete look broken.
   */
  let dismissedSessions: string[] = [];

  let store: KVStore | null = null;

  function sessionKey(agentName: string, sessionId: string): string {
    return `${agentName}::${sessionId}`;
  }

  /** Last path segment — used as a title when the agent reports none. */
  function folderName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() || '';
  }

  // ---- Tab management ------------------------------------------------------

  const activeRuntime = computed<SessionTab | null>(
    () => openTabs.value.find((t) => t.id === activeTabId.value) ?? null
  );

  /** True when sessions.json named tabs to reopen (read once at boot). */
  const hasStoredTabs = computed(() => storedTabs.length > 0);

  /** The session a tab represents — live once `session/load` resolved, or
   *  the intended target while a connect/resume is in flight or failed. */
  function tabSession(t: SessionTab): SavedSession | null {
    return t.session ?? t.descriptor;
  }

  /** The runtime already bound to this session, if a tab has it open. */
  function findTab(agentName: string, sessionId: string): SessionTab | undefined {
    return openTabs.value.find(
      (t) => tabSession(t)?.agentName === agentName && tabSession(t)?.sessionId === sessionId
    );
  }

  /** A fresh runtime viewed through the tabs array (refs unwrap on read). */
  function asTab(rt: SessionRuntime): SessionTab {
    return rt as unknown as SessionTab;
  }

  function spawnRuntime(): SessionRuntime {
    return createSessionRuntime({
      requestAuth: (methods, agent) => requestAuthMethod(methods, agent),
      persistSessions: saveSessionsToStore,
      notifyActivity: (rt) => {
        // Background work counts as unread on its tab. The active tab is on
        // screen already; marking it would just light a stale dot.
        if (rt.id !== activeTabId.value) rt.unread.value = true;
      },
    });
  }

  /**
   * Make `id` the foreground tab: clear its unread marker and point the URL
   * at it (F5 then restores this chat, not a stale one).
   */
  function activateTab(id: string): void {
    const rt = openTabs.value.find((t) => t.id === id);
    if (!rt) return;
    activeTabId.value = id;
    rt.unread = false;
    const s = tabSession(rt);
    if (s) setSessionInUrl(s.agentName, s.sessionId);
    void saveSessionsToStore();
  }

  /**
   * Open a tab for `savedSession` — or focus the one already bound to it —
   * and make sure the session is connected. Deleting a tab never deletes
   * the session; the agent keeps it.
   */
  async function openTab(
    savedSession: SavedSession,
    options?: { autonomous?: boolean }
  ): Promise<SessionTab> {
    const existing = findTab(savedSession.agentName, savedSession.sessionId);
    if (existing) {
      activateTab(existing.id);
      // Tab exists but its transport is down (failed resume, dropped socket)
      // — a click means "bring it up", not just "look at it".
      if (
        !existing.isConnected &&
        !existing.isConnecting &&
        !existing.isLoading &&
        savedSession.supportsLoadSession
      ) {
        await existing.resume(savedSession, options);
      }
      return existing;
    }

    const rt = spawnRuntime();
    openTabs.value.push(asTab(rt));
    activateTab(rt.id);
    try {
      await rt.resume(savedSession, options);
    } catch (e) {
      // The tab stays: its error banner is the failure report, and the user
      // can retry by clicking the sidebar row again or just close the tab.
      console.error('Failed to resume session:', e);
    }
    // Resume surfaced the agent's inventory the old way — keep that habit so
    // the sidebar mirrors whatever this agent holds.
    void syncAgentSessions(savedSession.agentName);
    return asTab(rt);
  }

  /**
   * Close a tab: disconnect its transport, flush its history tail, and move
   * focus to a neighbour. The session itself survives in `savedSessions`.
   */
  async function closeTab(id: string): Promise<void> {
    const idx = openTabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const rt = openTabs.value[idx];
    await rt.close();
    openTabs.value.splice(idx, 1);
    if (activeTabId.value === id) {
      const next = openTabs.value[idx] ?? openTabs.value[idx - 1] ?? null;
      activeTabId.value = null;
      if (next) activateTab(next.id);
      else setSessionInUrl('', null);
    }
    await saveSessionsToStore();
  }

  /**
   * Start a new session in a fresh tab. The runtime is pushed immediately so
   * the tab shows the startup/connecting state while `session/new` is in
   * flight; a failure leaves the tab with its error banner.
   */
  async function createSession(
    agentName: string,
    cwd: string,
    options?: { autonomous?: boolean }
  ): Promise<void> {
    const rt = spawnRuntime();
    openTabs.value.push(asTab(rt));
    activateTab(rt.id);
    orphanError.value = null;
    lastAgentName.value = agentName;
    try {
      const saved = await rt.create(agentName, cwd, options);
      savedSessions.value.push(saved);
      await saveSessionsToStore();
      // Now that the session exists the URL can point at it.
      setSessionInUrl(saved.agentName, saved.sessionId);
      // Auto-load the agent's session inventory once connected, so sessions
      // created outside this client (CLI, Telegram, another device) show up
      // in the sidebar without a manual refresh.
      void syncAgentSessions(agentName);
    } catch (e) {
      console.error('Failed to create session:', e);
      throw e;
    }
  }

  /**
   * Sidebar/other callers' resume entry point — same thing as opening a tab:
   * dedupe by agent+sessionId, focus the tab, connect if needed.
   */
  async function resumeSession(
    savedSession: SavedSession,
    options?: { autonomous?: boolean }
  ): Promise<void> {
    await openTab(savedSession, options);
  }

  /** Move focus `dir` tabs along the strip, wrapping at the ends (Ctrl+Tab). */
  function cycleTab(dir: 1 | -1): void {
    const tabs = openTabs.value;
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId.value);
    const next = tabs[(idx + dir + tabs.length) % tabs.length] ?? tabs[0];
    activateTab(next.id);
  }

  /** Reconnect every tab whose transport dropped (foreground path). */
  async function tryReconnect(): Promise<boolean> {
    let attempted = false;
    for (const rt of openTabs.value) {
      const tried = await rt.tryReconnect();
      attempted = attempted || tried;
    }
    return attempted;
  }

  // ---- Auth method picker (shared dialog, serialized across tabs) ---------

  function requestAuthMethod(methods: AuthMethod[], agentName: string): Promise<string | null> {
    return new Promise((resolve) => {
      authQueue.push({ methods, agentName, resolve });
      if (authQueue.length === 1) {
        pendingAuthMethods.value = methods;
        pendingAuthAgentName.value = agentName;
      }
    });
  }

  function settleAuth(methodId: string | null): void {
    const current = authQueue.shift();
    current?.resolve(methodId);
    const next = authQueue[0];
    pendingAuthMethods.value = next?.methods ?? [];
    pendingAuthAgentName.value = next?.agentName ?? '';
  }

  // User selected an auth method
  function selectAuthMethod(methodId: string): void {
    settleAuth(methodId);
  }

  // User cancelled auth selection — only the *front* request is cancelled;
  // queued runtimes keep waiting for their turn.
  function cancelAuthSelection(): void {
    settleAuth(null);
  }

  // ---- Agent-side session inventory ----------------------------------------

  /** Follow `nextCursor` until exhausted (bounded by MAX_SESSION_LIST_PAGES). */
  async function listAllAgentSessions(client: AcpClientBridge, cwd?: string): Promise<SessionInfo[]> {
    const all: SessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SESSION_LIST_PAGES; page++) {
      const response = await client.listSessions({ cursor, cwd });
      all.push(...(response.sessions ?? []));
      const next = response.nextCursor ?? undefined;
      // A repeated cursor would loop forever; treat it as the end of the list.
      if (!next || next === cursor) break;
      cursor = next;
    }
    return all;
  }

  /**
   * Fold the agent's session metadata into `savedSessions`.
   *
   * Rows already known locally (same agent + sessionId) are updated in place —
   * the agent's title and last-activity stamp win, since it is the source of
   * truth. Unknown rows are appended and can be resumed via `session/load`.
   */
  function mergeAgentSessions(agentName: string, infos: SessionInfo[]): number {
    const known = new Map(
      savedSessions.value.map((s) => [sessionKey(s.agentName, s.sessionId), s])
    );
    let added = 0;
    for (const info of infos) {
      const key = sessionKey(agentName, info.sessionId);
      if (dismissedSessions.includes(key)) continue;
      const stamp = info.updatedAt ? Date.parse(info.updatedAt) : NaN;
      const title = (info.title || '').trim() || folderName(info.cwd || '') || 'Session';
      const existing = known.get(key);
      if (existing) {
        existing.title = title;
        if (info.cwd) existing.cwd = info.cwd;
        if (Number.isFinite(stamp)) existing.lastUpdated = stamp;
        existing.supportsLoadSession = true;
        continue;
      }
      savedSessions.value.push({
        id: uuid(),
        agentName,
        sessionId: info.sessionId,
        title,
        lastUpdated: Number.isFinite(stamp) ? stamp : Date.now(),
        cwd: info.cwd || '',
        supportsLoadSession: true,
        origin: 'agent',
      });
      added++;
    }
    return added;
  }

  /** Record whether `agentName` answered initialize with `session/list`. */
  function markListSupport(agentName: string, supports: boolean): void {
    const i = listUnsupportedAgents.value.indexOf(agentName);
    if (supports && i >= 0) listUnsupportedAgents.value.splice(i, 1);
    else if (!supports && i < 0) listUnsupportedAgents.value.push(agentName);
  }

  /**
   * Pull one agent's session list into the sidebar inventory. Returns the
   * number of newly discovered rows, or the error message — it never throws,
   * so a multi-agent refresh can collect per-agent failures.
   *
   * Reuses a live tab connection when one already belongs to `agentName`;
   * otherwise opens a short-lived one. That second case is cheap: the bridge
   * keeps the agent process alive across WebSocket clients, so this is an
   * initialize round-trip, not a respawn. Session updates are deliberately
   * left unwired on a transient connection — it only issues requests.
   */
  async function syncOneAgentSessions(
    agentName: string,
    cwd?: string
  ): Promise<{ added: number; error: string | null }> {
    // Any open tab on this agent can carry the `session/list` call.
    // (cast: the tabs array surfaces the bridge through UnwrapRef — the
    // runtime object itself is the same.)
    const localTab = openTabs.value.find(
      (t) => tabSession(t)?.agentName === agentName && t.acpClient
    );
    let client = (localTab?.acpClient ?? null) as AcpClientBridge | null;
    let transient: AcpClientBridge | null = null;
    try {
      if (!client) {
        const configStore = useConfigStore();
        const agentConfig: AgentConfig | undefined = configStore.getAgent(agentName);
        if (!agentConfig) throw new Error(`Agent '${agentName}' not found in config`);
        transient = await createAcpClient({ name: agentName, config: agentConfig });
        client = transient;
        const initResponse = await initializeHandshake(client);
        const supports = !!initResponse.agentCapabilities?.sessionCapabilities?.list;
        markListSupport(agentName, supports);
        lastAgentName.value = agentName;
        if (!supports) return { added: 0, error: null };
      } else {
        // The tab's own handshake already answered the capability question.
        const supports = !localTab?.sessionListUnsupported;
        markListSupport(agentName, supports);
        if (!supports) return { added: 0, error: null };
      }

      const infos = await listAllAgentSessions(client, cwd);
      const added = mergeAgentSessions(agentName, infos);
      await saveSessionsToStore();
      trackEvent('SessionsListed', { agentName, total: String(infos.length) });
      return { added, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn('Failed to list agent sessions:', e);
      return { added: 0, error: message };
    } finally {
      if (transient) {
        try {
          await transient.disconnect();
        } catch (e) {
          console.warn('disconnect after session list failed:', e);
        }
      }
    }
  }

  /**
   * Single-agent sync used by the connect/resume paths: after a session on
   * `agentName` comes up, its inventory is refreshed so the merged sidebar
   * mirrors whatever the agent holds.
   */
  async function syncAgentSessions(agentName: string, cwd?: string): Promise<number> {
    if (!agentName || isSyncingSessions.value) return 0;
    isSyncingSessions.value = true;
    syncError.value = null;
    try {
      const result = await syncOneAgentSessions(agentName, cwd);
      syncError.value = result.error;
      return result.added;
    } finally {
      isSyncingSessions.value = false;
    }
  }

  /**
   * Refresh entry point for the UI. With an explicit agent name it syncs just
   * that agent; without one it syncs every configured agent in parallel —
   * the sidebar shows all sessions merged, so a refresh must too. Per-agent
   * failures land in `syncError` as `name: message` pairs.
   */
  async function refreshAgentSessions(agentName?: string): Promise<void> {
    const targets = agentName ? [agentName] : useConfigStore().agentNames;
    if (targets.length === 0) {
      syncError.value = 'No agents configured';
      return;
    }
    if (isSyncingSessions.value) return;
    isSyncingSessions.value = true;
    syncError.value = null;
    try {
      const results = await Promise.all(
        targets.map((name) => syncOneAgentSessions(name))
      );
      const errors = targets
        .map((name, i) => (results[i].error ? `${name}: ${results[i].error}` : ''))
        .filter(Boolean);
      syncError.value = errors.length ? errors.join('; ') : null;
    } finally {
      isSyncingSessions.value = false;
    }
  }

  // ---- Persistence ---------------------------------------------------------

  // Initialize store
  async function initStore() {
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<SavedSession[]>('sessions');
    if (saved) {
      savedSessions.value = saved;
    }
    // Sidebar rows the user removed while the agent still holds them.
    dismissedSessions = (await store.get<string[]>('dismissedSessions')) ?? [];
    hiddenSessionPrefixes.value =
      (await store.get<string[]>('hiddenSessionPrefixes')) ?? ['porch-delegate#', 'general-purpose#'];
    lastAgentName.value = (await store.get<string>('lastAgent')) ?? '';
    // The open-tab set: restored by `restoreTabs` once the app shell is up.
    storedTabs = (await store.get<StoredTab[]>('openTabs')) ?? [];
    storedActiveTab = (await store.get<StoredTab | null>('activeTab')) ?? null;
    // The panel's own attachment record (which files rode on which user turn,
    // and their bytes or a cache ref) — needed before any `session/load`
    // replay so image turns can be restored when the agent echoes no bytes.
    await loadAttachmentHistory();

    // Tail-cache hygiene: entries not opened in >7 days go, then the whole
    // cache is capped (~2 MiB, oldest sessions first). Synchronous — it is
    // localStorage, and it must finish before the first hydrate below.
    const evicted = evictHistoryCaches();
    if (evicted.removed > 0) {
      console.info(
        `history cache: evicted ${evicted.removed} entries, ` +
          `${evicted.entries} remain (${evicted.chars} chars)`
      );
    }

    await initRuntimeVersion();
  }

  /**
   * Reopen the tabs persisted at last shutdown and reconnect each of them.
   * Sessions the inventory no longer knows are skipped silently — the agent
   * may have dropped them. `focus` overrides which tab ends active (the
   * `?s=` URL param wins over the stored pointer).
   *
   * Restores run in parallel: the ws bridge multiplexes sessions over
   * separate sockets, and stdio agents spawn per tab anyway.
   */
  async function restoreTabs(focus?: StoredTab | null): Promise<void> {
    const target = focus ?? storedActiveTab;
    const toOpen: { tab: StoredTab; saved: SavedSession }[] = [];
    for (const tab of storedTabs) {
      const saved = savedSessions.value.find(
        (s) => s.agentName === tab.agentName && s.sessionId === tab.sessionId
      );
      if (saved) toOpen.push({ tab, saved });
    }
    // The `?s=` session may not be among the persisted tabs — a tab whose
    // resume was refused kept no `session` to persist. The URL is the
    // newest user intent, so it earns its own tab even then.
    if (
      target &&
      !toOpen.some(
        ({ saved }) =>
          sessionKey(saved.agentName, saved.sessionId) ===
          sessionKey(target.agentName, target.sessionId)
      )
    ) {
      const focusSaved = savedSessions.value.find(
        (s) => s.agentName === target.agentName && s.sessionId === target.sessionId
      );
      if (focusSaved) toOpen.push({ tab: target, saved: focusSaved });
    }
    if (toOpen.length === 0) return;

    // Tabs land in stored order; the focused one is activated after all are
    // pushed so activation doesn't bounce while resumes are in flight.
    const runtimes = new Map<string, SessionRuntime>();
    for (const { saved } of toOpen) {
      const rt = spawnRuntime();
      openTabs.value.push(asTab(rt));
      runtimes.set(sessionKey(saved.agentName, saved.sessionId), rt);
    }
    const focusKey = target ? sessionKey(target.agentName, target.sessionId) : null;
    const focusRt = focusKey ? runtimes.get(focusKey) ?? null : null;
    const focusTab = openTabs.value.find((t) => t.id === focusRt?.id) ?? openTabs.value[0];
    if (focusTab) {
      activeTabId.value = focusTab.id;
      const s =
        toOpen.find((t) => sessionKey(t.saved.agentName, t.saved.sessionId) === focusKey)?.saved ??
        toOpen[0].saved;
      setSessionInUrl(s.agentName, s.sessionId);
    }

    await Promise.allSettled(
      toOpen.map(({ saved }) => runtimes.get(sessionKey(saved.agentName, saved.sessionId))!.resume(saved))
    );
    void saveSessionsToStore();
  }

  async function saveSessionsToStore() {
    if (store) {
      await store.set('sessions', savedSessions.value);
      // Persist the open-tab set so a restart restores every chat, not just
      // the foreground one. Tabs that never got a session (failed creates)
      // have nothing to point at and drop out.
      await store.set(
        'openTabs',
        openTabs.value
          .map((t) => tabSession(t))
          .filter((s): s is SavedSession => s !== null)
          .map((s) => ({ agentName: s.agentName, sessionId: s.sessionId }))
      );
      const activeSession = activeRuntime.value ? tabSession(activeRuntime.value) : null;
      await store.set(
        'activeTab',
        activeSession
          ? { agentName: activeSession.agentName, sessionId: activeSession.sessionId }
          : null
      );
      // Legacy pointer kept in sync for older builds reading the same file.
      await store.set('currentSessionId', activeSession?.id ?? null);
      await store.save();
    }
  }

  // Remember the last agent we initialized against (persisted) so the sidebar
  // refresh works before any session is connected.
  watch(lastAgentName, async (name) => {
    if (!store || !name) return;
    await store.set('lastAgent', name);
    await store.save();
  });

  // ---- Computed -------------------------------------------------------------
  const hasActiveSession = computed(() => activeRuntime.value?.session != null);
  const messageList = computed(() => activeRuntime.value?.messageList ?? []);
  const toolCallList = computed(() => activeRuntime.value?.toolCallList ?? []);
  // Only sessions that support resuming (loadSession capability)
  const resumableSessions = computed(() =>
    savedSessions.value.filter(s => s.supportsLoadSession === true)
  );
  /** Gate duplicate session starts during connection, independently of turns. */
  const anySessionConnecting = computed(() =>
    openTabs.value.some((t) => t.isConnecting)
  );
  /** At least one background tab has unseen content or a pending permission. */
  const anyUnread = computed(() => openTabs.value.some((t) => t.unread));

  /**
   * Title prefixes hidden from the sidebar (subagent runs like
   * `porch-delegate#…` flood the inventory). User-edited in Settings,
   * persisted in sessions.json next to `dismissedSessions`. Matched on the
   * title the agent reported (session_info.name, else the first message).
   */
  const hiddenSessionPrefixes = ref<string[]>(['porch-delegate#', 'general-purpose#']);
  function isHiddenSession(s: SavedSession): boolean {
    return hiddenSessionPrefixes.value.some(
      (p) => p.length > 0 && s.title.startsWith(p)
    );
  }
  async function setHiddenSessionPrefixes(prefixes: string[]): Promise<void> {
    hiddenSessionPrefixes.value = prefixes
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (store) {
      await store.set('hiddenSessionPrefixes', hiddenSessionPrefixes.value);
      await store.save();
    }
  }

  // Delete saved session — also closes its tab if one is open.
  async function deleteSession(sessionId: string): Promise<void> {
    const doomed = savedSessions.value.find(s => s.id === sessionId);
    // A session the agent owns cannot be deleted from here — the agent would
    // hand it straight back on the next sync. Remember the dismissal instead
    // so the row stays gone; the history itself is untouched agent-side.
    if (doomed?.origin === 'agent') {
      const key = sessionKey(doomed.agentName, doomed.sessionId);
      if (!dismissedSessions.includes(key)) {
        dismissedSessions.push(key);
        if (store) {
          await store.set('dismissedSessions', dismissedSessions);
          await store.save();
        }
      }
    }
    if (doomed) {
      const openRt = findTab(doomed.agentName, doomed.sessionId);
      if (openRt) await closeTab(openRt.id);
    }
    savedSessions.value = savedSessions.value.filter(s => s.id !== sessionId);
    await saveSessionsToStore();
    // The panel's attachment record for that session goes too — otherwise a
    // different session that later reuses the same id would inherit files.
    if (doomed)
      void forgetSessionAttachments(`${doomed.agentName}::${doomed.sessionId}`);
  }

  const openSessionIds = computed(
    () =>
      new Set(
        openTabs.value
          .map((t) => tabSession(t)?.id)
          .filter((id): id is string => id !== undefined)
      )
  );
  /**
   * Sessions the sidebar shows: every agent's inventory merged and sorted by
   * last activity — the per-row agent chip carries the distinction that a
   * scoped list used to. Open tabs always show, even when hidden by a prefix
   * (otherwise the list would deny what a tab is displaying).
   */
  const visibleSessions = computed(() =>
    savedSessions.value
      .filter(s => s.supportsLoadSession === true)
      .filter(s => openSessionIds.value.has(s.id) || !isHiddenSession(s))
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
  );

  /**
   * True when EVERY configured agent is known to lack `session/list` — only
   * then is the refresh affordance useless and hidden. Until a sync attempt
   * the capability is unknown, so the button stays.
   */
  const sessionListUnsupported = computed(() => {
    const names = useConfigStore().agentNames;
    return (
      names.length > 0 &&
      names.every((n) => listUnsupportedAgents.value.includes(n))
    );
  });

  // ---- Active-tab facade (legacy single-session API) ------------------------
  // Components and the e2e (`window.__session`) keep reading these names;
  // every one now answers for the ACTIVE tab's runtime.

  const currentSession = computed(() => activeRuntime.value?.session ?? null);
  const messages = computed(() => activeRuntime.value?.messages ?? []);
  const isConnected = computed(() => activeRuntime.value?.isConnected ?? false);
  const isLoading = computed(() => activeRuntime.value?.isLoading ?? false);
  const isConnecting = computed(() => activeRuntime.value?.isConnecting ?? false);
  const isReconnecting = computed(() => activeRuntime.value?.isReconnecting ?? false);
  const historyCacheNote = computed(() => activeRuntime.value?.historyCacheNote ?? null);
  const pendingPermission = computed(() => activeRuntime.value?.pendingPermission ?? null);
  const availableModes = computed(() => activeRuntime.value?.availableModes ?? []);
  const currentModeId = computed(() => activeRuntime.value?.currentModeId ?? '');
  const availableCommands = computed(() => activeRuntime.value?.availableCommands ?? []);
  const availableModels = computed(() => activeRuntime.value?.availableModels ?? []);
  const currentModelId = computed(() => activeRuntime.value?.currentModelId ?? '');
  const startupPhase = computed(() => activeRuntime.value?.startupPhase ?? 'starting');
  const startupLogs = computed(() => activeRuntime.value?.startupLogs ?? []);
  const startupElapsed = computed(() => activeRuntime.value?.startupElapsed ?? 0);
  const supportsImages = computed(() => activeRuntime.value?.supportsImages ?? false);

  /** Writable error: lands on the active runtime, or the orphan slot. */
  const error = computed<string | null>({
    get: () => activeRuntime.value?.error ?? orphanError.value,
    set: (v) => {
      if (activeRuntime.value) activeRuntime.value.error = v;
      else orphanError.value = v;
    },
  });

  const autonomous = computed<boolean>({
    get: () => activeRuntime.value?.autonomous ?? false,
    set: (v) => activeRuntime.value?.setAutonomous(v),
  });

  function requireActive(): SessionTab {
    const rt = activeRuntime.value;
    if (!rt) throw new Error('No active session');
    return rt;
  }

  return {
    // State (facade delegates to the active tab)
    savedSessions,
    currentSession,
    messages,
    isConnected,
    isLoading,
    isConnecting,
    isReconnecting,
    error,
    pendingPermission,
    autonomous,
    permissionTimeoutMs: computed(() => PERMISSION_TIMEOUT_MS),
    pendingAuthMethods,
    pendingAuthAgentName,
    availableModes,
    currentModeId,
    availableCommands,
    availableModels,
    currentModelId,
    startupPhase,
    startupLogs,
    startupElapsed,
    supportsImages,
    isSyncingSessions,
    syncError,
    sessionListUnsupported,
    lastAgentName,
    historyCacheNote,
    hiddenSessionPrefixes,

    // Tabs
    openTabs,
    activeTabId,
    activeRuntime,
    anyUnread,
    anySessionConnecting,
    hasStoredTabs,

    // Computed
    hasActiveSession,
    messageList,
    toolCallList,
    resumableSessions,
    visibleSessions,

    // Actions
    initStore,
    restoreTabs,
    openTab,
    activateTab,
    closeTab,
    cycleTab,
    createSession,
    resumeSession,
    sendPrompt: (text: string, attachments?: import('../lib/types').Attachment[]) =>
      requireActive().sendPrompt(text, attachments),
    steer: (text: string, attachments?: import('../lib/types').Attachment[]) =>
      requireActive().steer(text, attachments),
    cancelOperation: () => activeRuntime.value?.cancelOperation(),
    cancelConnection: () => activeRuntime.value?.cancelConnection(),
    resolvePermission: (optionId: string) => activeRuntime.value?.resolvePermission(optionId),
    cancelPermission: () => activeRuntime.value?.cancelPermission(),
    setAutonomous: (v: boolean) => activeRuntime.value?.setAutonomous(v),
    setPermissionTimeout: (ms: number) => {
      setPermissionTimeoutMs(ms);
      for (const t of openTabs.value) t.setPermissionTimeout(ms);
    },
    selectAuthMethod,
    cancelAuthSelection,
    disconnect: () => (activeTabId.value ? closeTab(activeTabId.value) : Promise.resolve()),
    deleteSession,
    setMode: (modeId: string) => requireActive().setMode(modeId),
    setModel: (modelId: string) => requireActive().setModel(modelId),
    clearError: () => {
      orphanError.value = null;
      activeRuntime.value?.clearError();
    },
    tryReconnect,
    syncAgentSessions,
    refreshAgentSessions,
    setHiddenSessionPrefixes,

    // Expose client for permission handling
    get acpClient() { return activeRuntime.value?.acpClient ?? null; },
  };
});
