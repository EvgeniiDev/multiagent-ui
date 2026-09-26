// Session store for managing ACP sessions and persistence
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { getAppVersion } from '../lib/host';
import { trackEvent, trackError } from '../lib/telemetry';
import { uuid } from '../lib/uuid';
import type { SavedSession, ChatMessage, ToolCallInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig, Attachment, AttachmentMeta } from '../lib/types';
import { getTransportKind } from '../lib/types';
import { attachmentFromContentBlock } from '../lib/attachments';
import { loadAttachmentHistory, recordTurnAttachments, turnAttachments, forgetSessionAttachments, resolveCachedBytes } from '../lib/attachmentHistory';
import { readHistoryCache, writeHistoryCache, dropHistoryCache, evictHistoryCaches } from '../lib/historyCache';
import { AcpClientBridge, createAcpClient } from '../lib/acp-bridge';
import { onAgentStderr, spawnAgent, killAgent } from '../lib/host';
import { isDesktop } from '../lib/platform';
import { setSessionInUrl } from '../lib/sessionUrl';
import { useConfigStore } from './config';
import { useActivityStore } from './activity';
import type { SessionNotification, AuthMethod, SessionInfo, ContentBlock } from '@agentclientprotocol/sdk';

const STORE_PATH = 'sessions.json';
const PROTOCOL_VERSION = 1;

/**
 * `session/list` is cursor-paginated and the agent picks the page size
 * (Hermes caps at 50). Cap the loop so a misbehaving agent that returns the
 * same cursor forever can't spin the client: at 20 pages we surface what we
 * have and stop.
 */
const MAX_SESSION_LIST_PAGES = 20;

/**
 * Default ceiling for one pending `session/request_permission`: if neither
 * a human nor the autonomous path answers within this window, the client
 * closes the request honestly (`cancelPermission()`) and writes a
 * `permission` ledger entry — the turn must not hang forever.
 * Mutable export so the e2e can shorten it through the same code path
 * the production UI uses (no sleeps in the WS mock handler).
 */
export let PERMISSION_TIMEOUT_MS = 120000;
export function setPermissionTimeoutMs(ms: number): void {
  PERMISSION_TIMEOUT_MS = ms;
}

// App version (loaded once at startup)
let appVersion = '0.1.0';

// Startup phase detection patterns
function detectPhase(line: string): string | null {
  const lower = line.toLowerCase();
  if (lower.includes('download') || lower.includes('fetch') || lower.includes('get ')) {
    return 'downloading';
  }
  if (lower.includes('install') || lower.includes('added') || lower.includes('packages')) {
    return 'installing';
  }
  if (lower.includes('build') || lower.includes('compil')) {
    return 'building';
  }
  if (lower.includes('start') || lower.includes('spawn')) {
    return 'starting';
  }
  return null;
}

export const useSessionStore = defineStore('session', () => {
  // State
  const savedSessions = ref<SavedSession[]>([]);
  const currentSession = ref<SavedSession | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const toolCalls = ref<Map<string, ToolCallInfo>>(new Map());
  const isConnected = ref(false);
  const isLoading = ref(false);
  const isConnecting = ref(false);
  // True while a foreground reconnect attempt is in flight. Distinct from
  // `isConnecting` (which is the multi-phase initial spawn/connect path):
  // reconnects skip the spawn/stderr-progress UI and just need a small
  // "Reconnecting…" indicator.
  const isReconnecting = ref(false);
  const error = ref<string | null>(null);
  const pendingPermission = ref<PermissionRequest | null>(null);
  /**
   * Autonomous run: when true the client answers `session/request_permission`
   * itself with the allow-once option the agent offered (no dialog) and
   * writes a `permission` audit entry per auto-approval. Per-run state —
   * set on `createSession`/`resumeSession` via `options.autonomous`, never a
   * global toggle. Exposed on `window.__session` for the e2e only; the
   * production path sets it when a role/card starts the run.
   */
  const autonomous = ref(false);
  /** Real timeout handle for the currently pending permission request. */
  let permissionTimer: ReturnType<typeof setTimeout> | null = null;
  
  // Authentication state
  const pendingAuthMethods = ref<AuthMethod[]>([]);
  const pendingAuthAgentName = ref<string>('');
  let authMethodResolver: ((methodId: string | null) => void) | null = null;
  
  // Session modes
  const availableModes = ref<SessionMode[]>([]);
  const currentModeId = ref<string>('');
  
  // Slash commands
  const availableCommands = ref<SlashCommand[]>([]);
  
  // Session models
  const availableModels = ref<ModelInfo[]>([]);
  const currentModelId = ref<string>('');
  
  // Connection cancellation
  let connectionAborted = false;
  
  // Startup progress tracking
  const startupPhase = ref<string>('starting');
  const startupLogs = ref<string[]>([]);
  const startupElapsed = ref<number>(0);
  let startupTimer: ReturnType<typeof setInterval> | null = null;
  let stderrUnlisten: (() => void) | null = null;
  
  // Current ACP client
  let acpClient: AcpClientBridge | null = null;
  let store: KVStore | null = null;

  // ---- History tail cache (localStorage, write-through) -------------------
  // `session/load` can only replay the WHOLE transcript top-down (no tail
  // parameter, no sequence numbers), so "show the newest instantly" needs a
  // client-side copy. `acp-ui:history:<agent>::<sessionId>` keeps the last
  // ~100 rendered messages; the store rewrites it on every settled turn and
  // (throttled) while a replay streams, and reconciles against the fresh
  // replay at `session/load` resolve.
  /**
   * Drives the marker above the feed: 'loading' while a cached tail is on
   * screen and the replay is in flight, 'stale' when the replay died and the
   * tail is all there is, null for a live (or empty) transcript.
   */
  const historyCacheNote = ref<'loading' | 'stale' | null>(null);
  /** Session the cache writes belong to while `currentSession` isn't set. */
  let cacheScope: { agent: string; sessionId: string } | null = null;
  /**
   * While a cached tail is on screen, the `session/load` replay streams into
   * this side buffer instead of the rendered list — chunks appending below
   * the cache would duplicate it and drag the newest message out of view.
   * `settleReplayMerge` swaps the buffer in wholesale at load-resolve.
   */
  let replayMerge: {
    sessionId: string;
    cached: ChatMessage[];
    anchorIdx: number;
    buffer: ChatMessage[];
  } | null = null;

  const HISTORY_FLUSH_MS = 2000;
  let historyFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHistoryFlushAt = 0;

  // ---- Agent-side session inventory (`session/list`) -----------------------
  // The agent owns its history; this client mirrors the metadata into the
  // sidebar so sessions created elsewhere (CLI, Telegram, another device)
  // show up here and can be resumed.
  const supportsListSessions = ref(false);
  /** Agent accepts ACP `image` content blocks (promptCapabilities.image). */
  const supportsImages = ref(false);
  const isSyncingSessions = ref(false);
  const syncError = ref<string | null>(null);
  /**
   * The agent answered initialize without the `session/list` capability. Known
   * only after a sync attempt, so the UI hides the refresh affordance rather
   * than offering a button that can never work.
   */
  const sessionListUnsupported = ref(false);
  /** Agent of the most recent connection — the default target for a refresh. */
  const lastAgentName = ref('');
  /**
   * Agent whose sessions the sidebar is scoped to. Switching it blanks the list
   * and shows a loader while the agent's inventory is re-fetched, so a switch is
   * visibly different from "nothing happened".
   */
  const activeAgentName = ref('');
  /** True from an agent switch until that agent's session list settles. */
  const sidebarLoading = ref(false);
  /**
   * Outcome of the last inventory fetch, rendered next to the sidebar scope.
   * Without it a failed or empty sync is indistinguishable from a click that
   * did nothing.
   */
  const lastSync = ref<{ agent: string; count: number; ms: number; unsupported: boolean } | null>(null);
  /**
   * `${agentName}::${sessionId}` keys the user removed from the sidebar while
   * the agent still holds them. Persisted, because otherwise the next sync
   * would resurrect every deleted row and make Delete look broken.
   */
  let dismissedSessions: string[] = [];

  function sessionKey(agentName: string, sessionId: string): string {
    return `${agentName}::${sessionId}`;
  }

  /** Last path segment — used as a title when the agent reports none. */
  function folderName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() || '';
  }

  /**
   * Initialize a client and record which optional session features the agent
   * has. Only Tauri desktop has real filesystem access; mobile and web cannot
   * fulfil readTextFile / writeTextFile RPCs.
   */
  async function initializeClient(client: AcpClientBridge) {
    const canAccessFs = isDesktop();
    const initResponse = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: canAccessFs,
          writeTextFile: canAccessFs,
        },
      },
      clientInfo: {
        name: 'acp-ui',
        title: 'ACP UI',
        version: appVersion,
      },
    });
    supportsListSessions.value = !!initResponse.agentCapabilities?.sessionCapabilities?.list;
    sessionListUnsupported.value = !supportsListSessions.value;
    // Agents announce whether they accept image content blocks; attaching an
    // image to an agent that doesn't is a silent no-op on its side.
    supportsImages.value = !!initResponse.agentCapabilities?.promptCapabilities?.image;
    lastAgentName.value = currentSession.value?.agentName || lastAgentName.value;
    return initResponse;
  }

  /**
   * Build the ACP content blocks for one turn.
   *
   * Attachments go out inline — images as base64 `image` blocks, text files as
   * inline `resource` blocks. Both are self-contained on purpose: the agent
   * usually runs on another machine, so a `resource_link` pointing at a client
   * path would reach it as an unreadable URI.
   */
  function promptContentBlocks(text: string, attachments: Attachment[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    if (text) {
      blocks.push({ type: 'text', text });
    }
    for (const attachment of attachments) {
      // The URI is only a display name for the agent. Deliberately NOT a
      // `file://` path: agents parse such a URI as a path to read, ask the
      // client for `fs/read_text_file` (which the web build cannot serve) and
      // the turn dies in a permission prompt. Measured on OpenCode:
      // `file:///attached/x.txt` → permission request, turn cancelled;
      // `attachment://x.txt` → no request, content delivered.
      const uri = `attachment://${attachment.name}`;
      if (attachment.kind === 'image') {
        blocks.push({
          type: 'image',
          mimeType: attachment.mimeType || 'image/png',
          data: attachment.data,
          uri,
        });
      } else {
        blocks.push({
          type: 'resource',
          resource: { uri, mimeType: attachment.mimeType || 'text/plain', text: attachment.data },
        });
      }
    }
    return blocks;
  }

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

  /**
   * Pull the agent's own session list into the sidebar.
   *
   * Reuses the live connection when it already belongs to `agentName`;
   * otherwise opens a short-lived one. That second case is cheap: the bridge
   * keeps the agent process alive across WebSocket clients, so this is an
   * initialize round-trip, not a respawn. Session updates are deliberately
   * left unwired on a transient connection — it only issues requests.
   */
  async function syncAgentSessions(agentName: string, cwd?: string): Promise<number> {
    if (!agentName || isSyncingSessions.value) return 0;
    isSyncingSessions.value = true;
    syncError.value = null;
    const startedAt = Date.now();
    let transient: AcpClientBridge | null = null;
    try {
      let client: AcpClientBridge | null =
        acpClient && currentSession.value?.agentName === agentName ? acpClient : null;

      if (!client) {
        const configStore = useConfigStore();
        const agentConfig: AgentConfig | undefined = configStore.getAgent(agentName);
        if (!agentConfig) throw new Error(`Agent '${agentName}' not found in config`);
        transient = await createAcpClient({ name: agentName, config: agentConfig });
        client = transient;
        const initResponse = await initializeClient(client);
        lastAgentName.value = agentName;
        if (!initResponse.agentCapabilities?.sessionCapabilities?.list) {
          lastSync.value = { agent: agentName, count: 0, ms: Date.now() - startedAt, unsupported: true };
          return 0;
        }
      } else if (!supportsListSessions.value) {
        lastSync.value = { agent: agentName, count: 0, ms: Date.now() - startedAt, unsupported: true };
        return 0;
      }

      const infos = await listAllAgentSessions(client, cwd);
      const added = mergeAgentSessions(agentName, infos);
      await saveSessionsToStore();
      lastSync.value = { agent: agentName, count: infos.length, ms: Date.now() - startedAt, unsupported: false };
      trackEvent('SessionsListed', { agentName, total: String(infos.length) });
      return added;
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : String(e);
      lastSync.value = { agent: agentName, count: 0, ms: Date.now() - startedAt, unsupported: false };
      console.warn('Failed to list agent sessions:', e);
      return 0;
    } finally {
      if (transient) {
        try {
          await transient.disconnect();
        } catch (e) {
          console.warn('disconnect after session list failed:', e);
        }
      }
      isSyncingSessions.value = false;
    }
  }

  /**
   * Refresh entry point for the UI: default to the connected agent, else the
   * selected one (nothing is connected yet), else the last agent we talked to.
   */
  async function refreshAgentSessions(agentName?: string): Promise<void> {
    const target = agentName || currentSession.value?.agentName || lastAgentName.value;
    if (!target) {
      syncError.value = 'Select an agent first';
      return;
    }
    await syncAgentSessions(target);
  }

  /**
   * Point the sidebar at `agentName` and load its inventory.
   *
   * The visible list is intentionally blank while the first page is in flight
   * (switching agents must look like a load, not like a no-op). Re-selecting
   * the agent already shown keeps the rows and just re-fetches.
   */
  async function setActiveAgent(agentName: string): Promise<void> {
    if (!agentName) return;
    const switched = activeAgentName.value !== agentName;
    activeAgentName.value = agentName;
    if (switched) {
      sidebarLoading.value = true;
      syncError.value = null;
    }
    try {
      await syncAgentSessions(agentName);
    } finally {
      sidebarLoading.value = false;
    }
  }

  // Computed
  const hasActiveSession = computed(() => currentSession.value !== null);
  const messageList = computed(() => messages.value);
  const toolCallList = computed(() => Array.from(toolCalls.value.values()));
  // Only sessions that support resuming (loadSession capability)
  const resumableSessions = computed(() => 
    savedSessions.value.filter(s => s.supportsLoadSession === true)
  );

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

  /**
   * Sessions the sidebar shows: the agent-scoped view of the inventory the
   * agent itself reported. Scoping per agent keeps a 170-row mixed list
   * legible — switching agents is the filter. The open session always shows,
   * even when hidden by a prefix (otherwise the list would deny what the
   * chat view is displaying).
   */
  const visibleSessions = computed(() =>
    activeAgentName.value
      ? savedSessions.value
          .filter(s => s.agentName === activeAgentName.value && s.supportsLoadSession === true)
          .filter(s => s.id === currentSession.value?.id || !isHiddenSession(s))
          .sort((a, b) => b.lastUpdated - a.lastUpdated)
      : []
  );

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
    // Restore the open-session pointer (written by saveSessionsToStore on
    // every connect/resume/send). The live bridge is gone after a reload —
    // App.vue re-establishes it via resumeSession once the stores boot.
    const lastOpenId = await store.get<string>('currentSessionId');
    if (lastOpenId) {
      const found = savedSessions.value.find((s) => s.id === lastOpenId);
      if (found) currentSession.value = found;
    }
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

    // Load app version (Tauri API on desktop/mobile, build-time inject on web)
    try {
      appVersion = await getAppVersion();
    } catch (e) {
      console.warn('Failed to get app version:', e);
    }
  }

  async function saveSessionsToStore() {
    if (store) {
      await store.set('sessions', savedSessions.value);
      // The live connection dies on reload, but the *pointer* to the open
      // session must survive it — otherwise F5 drops the user to the
      // welcome screen even though the session list (and the agent holding
      // the history) still has the session.
      await store.set('currentSessionId', currentSession.value?.id ?? null);
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

  // Handle an unexpected transport close (e.g. WebSocket dropped while idle,
  // local agent process exited). The bridge has already rejected any
  // in-flight requests; we just need to tear down UI state so the user gets
  // a clear "disconnected" signal instead of a stale "connected" view.
  function handleUnexpectedClose(reason?: string): void {
    // If `acpClient` is already null, this fired during a voluntary
    // disconnect that's tearing down anyway — nothing to do.
    if (!acpClient) return;
    acpClient = null;
    isConnected.value = false;
    isLoading.value = false;
    // A transport drop mid-replay keeps the cached tail on screen (stale).
    abortReplayMerge();
    clearPermissionTimer();
    pendingPermission.value = null;
    error.value = `Connection lost: ${reason ?? 'transport closed'}`;
  }

  // ---- Autonomous permission handling (W6-B) -------------------------------
  // A pending `session/request_permission` is answered exactly once, by the
  // first of: the autonomous path, the human, or the timeout. The timer is
  // the backstop — it closes the request honestly via `cancelPermission()`
  // so a turn never hangs forever.

  function clearPermissionTimer(): void {
    if (permissionTimer !== null) {
      clearTimeout(permissionTimer);
      permissionTimer = null;
    }
  }

  function recordPermissionEntry(request: PermissionRequest, detail: string): void {
    useActivityStore().recordEntry({
      kind: 'permission',
      agentName: currentSession.value?.agentName ?? 'unknown',
      sessionId: request.sessionId || currentSession.value?.sessionId,
      cwd: currentSession.value?.cwd,
      title: request.toolCall.title || request.toolCall.toolCallId,
      detail,
    });
  }

  /** The allow-once option the agent offered, if any. */
  function pickAllowOption(request: PermissionRequest): PermissionRequest['options'][number] | null {
    return (
      request.options.find((o) => o.kind === 'allow_once') ??
      request.options.find((o) => o.kind.startsWith('allow')) ??
      null
    );
  }

  function onPermissionTimeout(): void {
    permissionTimer = null;
    const request = pendingPermission.value;
    if (!request) return;
    recordPermissionEntry(
      request,
      `permission request timed out after ${Math.ceil(PERMISSION_TIMEOUT_MS / 1000)}s (no answer)`
    );
    cancelPermission();
  }

  function armPermissionTimer(): void {
    clearPermissionTimer();
    permissionTimer = setTimeout(onPermissionTimeout, PERMISSION_TIMEOUT_MS);
  }

  /**
   * Single entry point for every permission request the bridge reports.
   * Autonomous sessions never populate `pendingPermission` (so App.vue
   * mounts no `.permission-dialog`) — they answer immediately and audit.
   * Manual sessions publish the request for the dialog and arm the timeout.
   * A `null` report means the request settled elsewhere: drop the dialog
   * and the timer.
   */
  function handlePermissionRequest(request: PermissionRequest | null): void {
    if (!request) {
      clearPermissionTimer();
      pendingPermission.value = null;
      return;
    }
    if (autonomous.value) {
      const allow = pickAllowOption(request);
      if (allow) {
        recordPermissionEntry(
          request,
          `auto-approve: autonomous run (option "${allow.name}" / ${allow.optionId})`
        );
        resolvePermission(allow.optionId);
      } else {
        recordPermissionEntry(
          request,
          'auto-deny: autonomous run (no allow option offered by agent)'
        );
        cancelPermission();
      }
      return;
    }
    pendingPermission.value = request;
    armPermissionTimer();
  }

  /** Enable/disable the autonomous run for the current session. */
  function setAutonomous(value: boolean): void {
    autonomous.value = value;
  }

  /**
   * Shorten/lengthen the permission ceiling (ms) through the same code path
   * the production UI uses. Exists for the e2e; production leaves the
   * 120 s default alone. Re-arms the timer when a request is pending.
   */
  function setPermissionTimeout(ms: number): void {
    setPermissionTimeoutMs(ms);
    if (pendingPermission.value && !autonomous.value) armPermissionTimer();
  }

  // ---- Attachment plumbing for replayed/streamed messages ------------------
  // A content block is not always text: a replayed user or agent turn can
  // carry `image`, `resource`, `resource_link`, `audio` blocks. Dropping them
  // made multimodal turns vanish from history on reload. Blocks with real
  // bytes become renderable attachments; blocks with none still become named
  // placeholders, so the transcript never pretends the file was not there.

  /**
   * Agent behind the session currently being created/resumed. During a
   * replay `currentSession` is not set yet (it lands after `session/load`
   * resolves), so the merge below can't ask it — this is filled in by
   * `createSession`/`resumeSession` before the replay starts.
   */
  let replayAgentName = '';
  function attachmentScope(sessionId: string): string {
    const agent = replayAgentName || currentSession.value?.agentName || '';
    return `${agent}::${sessionId}`;
  }

  /** Copy recoverable fields from `src` into `dst` when `dst` lacks them. */
  function fillAttachment(dst: AttachmentMeta, src: AttachmentMeta): void {
    if (!dst.previewUrl && src.previewUrl) dst.previewUrl = src.previewUrl;
    if (!dst.body && src.body) dst.body = src.body;
    if (!dst.cachePath && src.cachePath) dst.cachePath = src.cachePath;
    if (dst.previewUrl || dst.body) dst.unavailableReason = undefined;
  }

  /** Attach a non-text content block to a message, deduped by name+kind. */
  function attachContentBlock(msg: ChatMessage, block: ContentBlock): void {
    const meta = attachmentFromContentBlock(block);
    if (!meta) {
      console.log('Unhandled content block:', block.type);
      return;
    }
    msg.attachments = msg.attachments ?? [];
    const existing = msg.attachments.find(
      (a) => a.name === meta.name && a.kind === meta.kind
    );
    if (existing) fillAttachment(existing, meta);
    else msg.attachments.push(meta);
  }

  /**
   * Merge the panel's own attachment record into a replayed user message.
   * `userTurnIndex` is the message's ordinal among user turns in the FULL
   * transcript — the same numbering `sendPrompt` used when recording, so
   * position correlates them regardless of which device sent the turn.
   * Callers count user messages in whatever array `msg` was just pushed to
   * (the merge buffer counts from the top like a live transcript; a hydrated
   * tail adds the entry's `userTurnBase` offset).
   */
  function mergeRecordedAttachments(sessionId: string, msg: ChatMessage, userTurnIndex: number): void {
    const recorded = turnAttachments(attachmentScope(sessionId), userTurnIndex);
    if (!recorded.length) return;
    msg.attachments = msg.attachments ?? [];
    for (const rec of recorded) {
      const existing = msg.attachments.find(
        (a) => a.name === rec.name && a.kind === rec.kind
      );
      if (existing) {
        fillAttachment(existing, rec);
        continue;
      }
      // Clone: resolving a `cache:`/`local:` ref fills previewUrl lazily —
      // that must not leak back into the stored document.
      const meta: AttachmentMeta = { ...rec };
      if (!meta.previewUrl && !meta.body) {
        if (meta.cachePath) void resolveCachedBytes(meta);
        else if (!meta.unavailableReason) {
          meta.unavailableReason = 'the panel record kept no bytes for this file';
        }
      }
      msg.attachments.push(meta);
    }
  }

  // ---- Tail-cache plumbing ------------------------------------------------
  // Three moments: hydrate (paint the cached tail before the replay starts),
  // settle (the replay resolved — it is the truth, swap it in), abort (the
  // replay died — keep the tail, marked stale). Writes are fire-and-forget:
  // a localStorage failure must never break the chat.

  /** Persist the rendered tail under `cacheScope`. Never throws. */
  function flushHistoryNow(): void {
    if (historyFlushTimer) {
      clearTimeout(historyFlushTimer);
      historyFlushTimer = null;
    }
    lastHistoryFlushAt = Date.now();
    if (!cacheScope || messages.value.length === 0) return;
    writeHistoryCache(cacheScope.agent, cacheScope.sessionId, messages.value);
  }

  /** At most one write per HISTORY_FLUSH_MS while chunks stream in. */
  function throttledHistoryFlush(): void {
    if (!cacheScope) return;
    const wait = lastHistoryFlushAt + HISTORY_FLUSH_MS - Date.now();
    if (wait <= 0) {
      flushHistoryNow();
    } else if (!historyFlushTimer) {
      historyFlushTimer = setTimeout(flushHistoryNow, wait);
    }
  }

  // A turn settling / a replay finishing is the natural flush point.
  watch(isLoading, (loading) => {
    if (!loading) flushHistoryNow();
  });

  /** Same transcript entry? Roles, text, thought, tool calls, attachments. */
  function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
    if (a.role !== b.role || a.content !== b.content) return false;
    if ((a.thought ?? '') !== (b.thought ?? '')) return false;
    const tc = (m: ChatMessage) => (m.toolCalls ?? []).map((t) => t.toolCallId).join(' ');
    if (tc(a) !== tc(b)) return false;
    const at = (m: ChatMessage) =>
      (m.attachments ?? []).map((x) => `${x.kind}:${x.name}`).join(' ');
    return at(a) === at(b);
  }

  /**
   * Render the cached tail synchronously, BEFORE the connect/replay work of
   * `resumeSession`. Arms `replayMerge` so `handleSessionUpdate` routes the
   * coming replay into the side buffer. Returns false when nothing usable
   * is cached (the caller then takes the old clear-and-stream path).
   */
  function hydrateHistoryCache(agent: string, sessionId: string): boolean {
    const entry = readHistoryCache(agent, sessionId);
    if (!entry || entry.messages.length === 0) return false;
    // Clone: chunk appends and tool-call updates mutate message objects in
    // place — that must never write back into the stored copy.
    messages.value = [];
    toolCalls.value.clear();
    let anchorIdx = -1;
    const cached: ChatMessage[] = [];
    for (const stored of entry.messages) {
      const msg: ChatMessage = {
        ...stored,
        toolCalls: stored.toolCalls?.map((t) => ({
          ...t,
          locations: t.locations?.map((l) => ({ ...l })),
        })),
        attachments: stored.attachments?.map((a) => ({ ...a })),
      };
      cached.push(msg);
      messages.value.push(msg);
      if (msg.role === 'user') {
        anchorIdx = cached.length - 1;
        // Same restore the replay path does: the panel's own record carries
        // the files that rode on this user turn (agents echo no bytes). The
        // tail starts mid-transcript, so ordinals need `userTurnBase`.
        mergeRecordedAttachments(
          sessionId,
          msg,
          entry.userTurnBase + messages.value.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0)
        );
      }
      // Byte refs (`local:`/`cache:`) resolve lazily, exactly like replay.
      for (const a of msg.attachments ?? []) {
        if (a.cachePath && !a.previewUrl && !a.body) void resolveCachedBytes(a);
      }
      for (const t of msg.toolCalls ?? []) {
        toolCalls.value.set(t.toolCallId, { ...t });
      }
    }
    if (anchorIdx < 0) anchorIdx = cached.length - 1;
    replayMerge = { sessionId, cached, anchorIdx, buffer: [] };
    historyCacheNote.value = 'loading';
    return true;
  }

  /**
   * The replay resolved — it is the truth. The cached tail must appear in it
   * as one contiguous slice (aligned on the last cached user message): when
   * it does, the replay is the same history, possibly extended with turns
   * written elsewhere — render it, reusing the cached ids so identical rows
   * keep their DOM nodes. No alignment means the agent's history diverged
   * (compressed, rewound): drop the stale entry and still render the replay
   * — a fresh transcript must never pose as the cached one.
   */
  function settleReplayMerge(): void {
    const merge = replayMerge;
    replayMerge = null;
    if (!merge) return;
    const replayed = merge.buffer;
    const cached = merge.cached;
    const anchor = cached[merge.anchorIdx];
    let base = -1;
    for (let ai = replayed.length - 1; ai >= 0; ai--) {
      const cand = replayed[ai];
      if (cand.role !== anchor.role || cand.content !== anchor.content) continue;
      const b = ai - merge.anchorIdx;
      if (b < 0 || b + cached.length > replayed.length) continue;
      let ok = true;
      for (let i = 0; i < cached.length; i++) {
        if (!sameMessage(cached[i], replayed[b + i])) {
          ok = false;
          break;
        }
      }
      if (ok) {
        base = b;
        break;
      }
    }
    if (base < 0) {
      if (cacheScope) dropHistoryCache(cacheScope.agent, cacheScope.sessionId);
    } else {
      for (let i = 0; i < cached.length; i++) {
        replayed[base + i].id = cached[i].id;
      }
    }
    messages.value = replayed;
    toolCalls.value.clear();
    for (const m of replayed) {
      for (const t of m.toolCalls ?? []) {
        toolCalls.value.set(t.toolCallId, { ...t });
      }
    }
    historyCacheNote.value = null;
    flushHistoryNow();
  }

  /**
   * The replay died before `session/load` resolved (transport drop, agent
   * error). The partial buffer is a PREFIX of the truth — never a tail — so
   * it is discarded; `messages` still holds the cached tail, now honestly
   * marked as the stale copy it is.
   */
  function abortReplayMerge(): void {
    if (!replayMerge) return;
    replayMerge = null;
    if (historyCacheNote.value === 'loading') historyCacheNote.value = 'stale';
  }

  // Session update handler
  function handleSessionUpdate(notification: SessionNotification) {
    const update = notification.update;

    // One bridge process feeds every connected tab, so a `session/update`
    // can belong to a session this client never opened (another tab's
    // `session/load` replay, another window's turn). Expected here: the
    // session whose replay is mid-flight (merge buffer, or `cacheScope` when
    // there is no cached tail — `currentSession` still names the previous
    // chat until `session/load` resolves), else the open session. Anything
    // else is cross-talk and must not touch the transcript, the tool-call
    // map, or per-session UI state. `usage_update` is ledger data rather
    // than transcript, so it is kept — attributed to the sessionId the
    // frame actually names.
    const expectedSessionId =
      replayMerge?.sessionId ?? cacheScope?.sessionId ?? currentSession.value?.sessionId;
    const foreign =
      !!notification.sessionId && notification.sessionId !== expectedSessionId;

    // `usage_update` is sent on the wire (tokens used against a window, with an
    // optional cost) but is not in the SDK's typed union yet, so it is handled
    // before the switch that relies on that union for narrowing.
    const untyped = update as {
      sessionUpdate: string;
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string };
    };
    if (untyped.sessionUpdate === 'usage_update') {
      useActivityStore().recordUsage({
        agentName: replayAgentName || currentSession.value?.agentName || 'unknown',
        sessionId: notification.sessionId || currentSession.value?.sessionId || 'unknown',
        cwd: foreign ? undefined : currentSession.value?.cwd,
        used: Number(untyped.used ?? 0),
        size: Number(untyped.size ?? 0),
        cost: typeof untyped.cost?.amount === 'number' ? untyped.cost.amount : undefined,
        currency: untyped.cost?.currency,
        source: 'agent',
        // The panel knows the session's announced model (models.currentModelId
        // from session/new, or the picker's last setModel) but never a provider.
        model: foreign ? 'unknown' : currentModelId.value || 'unknown',
        provider: 'unknown',
      });
      return;
    }

    if (foreign) return;

    // While a cached tail is on screen, the replay lands in the merge buffer
    // — appending it to `messages` would duplicate the cache and push the
    // newest (cached) message out of the pinned view.
    const sink =
      replayMerge && notification.sessionId === replayMerge.sessionId
        ? replayMerge.buffer
        : messages.value;

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        // Append to last user message or create new (for replay)
        let target = sink[sink.length - 1];
        if (!target || target.role !== 'user') {
          target = {
            id: uuid(),
            role: 'user',
            content: '',
            timestamp: Date.now(),
          };
          sink.push(target);
          // A brand-new replayed user turn: restore the files the panel
          // recorded for this ordinal (agents don't echo image bytes). The
          // sink counts from the top of the transcript, matching the
          // numbering `recordTurnAttachments` used in `sendPrompt`.
          mergeRecordedAttachments(
            notification.sessionId,
            target,
            sink.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0)
          );
        }
        if (update.content.type === 'text') {
          target.content += update.content.text;
        } else {
          attachContentBlock(target, update.content);
        }
        break;
      }

      case 'agent_message_chunk': {
        // Append to last assistant message or create new
        let target = sink[sink.length - 1];
        if (!target || target.role !== 'assistant') {
          target = {
            id: uuid(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [],
          };
          sink.push(target);
        }
        if (update.content.type === 'text') {
          target.content += update.content.text;
        } else {
          attachContentBlock(target, update.content);
        }
        break;
      }

      case 'agent_thought_chunk':
        // Append to last assistant message's thought field or create new
        const lastAssistantMsg = sink[sink.length - 1];
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastAssistantMsg.thought = (lastAssistantMsg.thought || '') + update.content.text;
          }
        } else {
          sink.push({
            id: uuid(),
            role: 'assistant',
            content: '',
            thought: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;

      case 'tool_call': {
        // Chips render per assistant message, so a call that arrives before
        // the agent has written anything (the common case — the model calls a
        // tool first) has to open that message itself. Otherwise every
        // intermediate step is dropped and a running turn looks silent until
        // the final text lands.
        let targetMsg = sink[sink.length - 1];
        if (!targetMsg || targetMsg.role !== 'assistant') {
          targetMsg = {
            id: uuid(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [],
          };
          sink.push(targetMsg);
        }
        if (!targetMsg.toolCalls) {
          targetMsg.toolCalls = [];
        }
        targetMsg.toolCalls.push({
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
        });
        // Also keep in global map for updates
        toolCalls.value.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
        });
        useActivityStore().recordEntry({
          kind: 'tool-call',
          agentName: replayAgentName || currentSession.value?.agentName || 'unknown',
          sessionId: notification.sessionId,
          cwd: currentSession.value?.cwd,
          title: update.title,
          detail: update.kind || 'other',
        });
        break;
      }

      case 'tool_call_update':
        const existing = toolCalls.value.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          // Also update in the message's toolCalls array
          for (const msg of sink) {
            if (msg.toolCalls) {
              const tc = msg.toolCalls.find(t => t.toolCallId === update.toolCallId);
              if (tc) {
                if (update.status) tc.status = update.status;
                if (update.title) tc.title = update.title;
              }
            }
          }
        }
        break;

      case 'current_mode_update':
        // Agent changed the mode
        if ('modeId' in update && update.modeId) {
          currentModeId.value = update.modeId as string;
        }
        break;

      case 'available_commands_update':
        // Agent advertised slash commands
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          availableCommands.value = update.availableCommands.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            hint: cmd.input?.hint ?? undefined,
          }));
        }
        break;

      // ---- ledger: everything below feeds Timeline / Events / Dashboard ----
      case 'session_info_update': {
        const info = update as { title?: string | null; updatedAt?: string | null };
        useActivityStore().recordEntry({
          kind: 'sync',
          agentName: replayAgentName || currentSession.value?.agentName || 'unknown',
          sessionId: notification.sessionId,
          cwd: currentSession.value?.cwd,
          title: info.title ?? currentSession.value?.title,
          detail: 'session info updated',
        });
        break;
      }

      default:
        console.log('Unhandled session update:', update);
    }

    // Write-through: the tail cache follows the stream (throttled), so a
    // reload mid-replay still lands on the newest chunk seen so far.
    throttledHistoryFlush();
  }

  // Prompt user to select auth method
  async function promptForAuthMethod(authMethods: AuthMethod[], agentName: string): Promise<string | null> {
    return new Promise((resolve) => {
      pendingAuthMethods.value = authMethods;
      pendingAuthAgentName.value = agentName;
      authMethodResolver = resolve;
    });
  }

  // User selected an auth method
  function selectAuthMethod(methodId: string): void {
    if (authMethodResolver) {
      authMethodResolver(methodId);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // User cancelled auth selection
  function cancelAuthSelection(): void {
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // Create new session
  async function createSession(
    agentName: string,
    cwd: string,
    options?: { autonomous?: boolean }
  ): Promise<void> {
    isLoading.value = true;
    isConnecting.value = true;
    connectionAborted = false;
    error.value = null;
    // Autonomous is per-run, not a global toggle: reset on every connect so
    // a manual session never inherits it from a previous run.
    autonomous.value = options?.autonomous ?? false;
    // Attachment records are keyed agent::session — known before the session
    // id exists, so the replay merge can look them up while currentSession
    // is still null.
    replayAgentName = agentName;
    // No session id yet — cache writes wait until `session/new` returns it.
    cacheScope = null;
    historyCacheNote.value = null;
    replayMerge = null;

    // Look up the agent's transport kind so we know whether to do the
    // stdio-only startup choreography (spawn → stderr progress) or the
    // streamlined remote path (just open a network transport).
    const configStore = useConfigStore();
    const agentConfig: AgentConfig | undefined = configStore.getAgent(agentName);
    const transportKind = agentConfig
      ? getTransportKind(agentConfig)
      : 'stdio';
    const isRemote = transportKind !== 'stdio';

    // Reset and start progress tracking
    startupPhase.value = 'starting';
    startupLogs.value = [];
    startupElapsed.value = 0;
    startupTimer = setInterval(() => {
      startupElapsed.value++;
    }, 1000);

    // Track the spawned stdio instance separately so we can `killAgent` it
    // if cancellation/abort happens before we've wrapped it in a bridge.
    // Once `acpClient` is set, ownership transfers to the bridge and
    // `acpClient.disconnect()` becomes the only correct cleanup path.
    let spawnedInstance: { id: string } | null = null;

    try {
      if (!agentConfig) {
        throw new Error(`Agent '${agentName}' not found in config`);
      }

      if (!isRemote) {
        // For stdio agents we need the spawned process's id up front so the
        // stderr listener can filter on it (multiple agents may be running
        // concurrently). We spawn here, hand the resulting AgentInstance to
        // a StdioTransport, then build the bridge from that transport.
        startupPhase.value = 'starting';
        const agentInstance = await spawnAgent(agentName);
        spawnedInstance = agentInstance;

        stderrUnlisten = await onAgentStderr((stderr) => {
          if (stderr.agent_id !== agentInstance.id) return;
          startupLogs.value.push(stderr.line);
          // Detect phase from output
          const detectedPhase = detectPhase(stderr.line);
          if (detectedPhase) {
            startupPhase.value = detectedPhase;
          }
        }) as unknown as () => void;

        if (connectionAborted) {
          // Process was spawned but no bridge exists yet — kill the orphan
          // before throwing so the local agent doesn't keep running.
          await killAgent(agentInstance.id).catch((err) =>
            console.warn('killAgent during abort failed:', err)
          );
          spawnedInstance = null;
          throw new Error('Connection cancelled');
        }

        startupPhase.value = 'initializing';

        // Wrap the just-spawned instance in a StdioTransport. Using the
        // legacy single-arg form keeps backward compatibility and avoids a
        // double-spawn (StdioTransport.spawn would call spawnAgent again).
        acpClient = await createAcpClient(agentInstance);
        // Ownership of the child process now belongs to the bridge — clear
        // our local reference so the catch block doesn't double-kill it.
        spawnedInstance = null;
      } else {
        // Remote agents have no stderr stream; show a minimal "connecting"
        // state instead of the multi-phase progress UI.
        startupPhase.value = 'connecting';

        if (connectionAborted) {
          throw new Error('Connection cancelled');
        }

        // The factory opens a WebSocket / HTTP connection based on
        // agentConfig.transport.
        acpClient = await createAcpClient({ name: agentName, config: agentConfig });
      }

      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket drop while idle)
      // to the UI so users don't sit on a stale "connected" state forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };
      
      // Route bridge permission requests through the autonomous/timeout path.
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          handlePermissionRequest(newValue ?? null);
        },
        { immediate: true }
      );

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      startupPhase.value = 'connecting';

      // Initialize connection
      const initResponse = await initializeClient(acpClient);

      console.log('Agent initialized:', initResponse);

      // Check if agent supports session loading
      const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      // Try to create session - may fail with auth_required
      let sessionResponse;
      try {
        sessionResponse = await acpClient.newSession({
          cwd,
          mcpServers: [],
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');
        
        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          
          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, agentName);
          
          if (!selectedMethodId || connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }
          
          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          if (connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Connection cancelled');
          }

          // Retry session creation after auth
          sessionResponse = await acpClient.newSession({
            cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      // Save session
      // Name the session after its workspace folder — an auto-generated
      // "Session <date>" title is noise next to the sidebar timestamp.
      const folder = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
      const session: SavedSession = {
        id: uuid(),
        agentName,
        sessionId: sessionResponse.sessionId,
        title: folder,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };

      // A fresh session has no replay to validate a tail against — if the
      // agent recycled a sessionId, the old tail must not resurrect as if
      // it were this session's history.
      dropHistoryCache(agentName, sessionResponse.sessionId);
      cacheScope = { agent: agentName, sessionId: sessionResponse.sessionId };

      currentSession.value = session;
      savedSessions.value.push(session);
      await saveSessionsToStore();
      
      isConnected.value = true;
      messages.value = [];
      toolCalls.value.clear();

      const activity = useActivityStore();
      activity.recordEntry({
        kind: 'connected',
        agentName,
        sessionId: sessionResponse.sessionId,
        cwd,
        title: folder,
      });
      activity.recordEntry({
        kind: 'session-open',
        agentName,
        sessionId: sessionResponse.sessionId,
        cwd,
        title: folder,
        detail: 'new session',
      });

      // Track successful session creation
      trackEvent('SessionCreated', { agentName, success: 'true' });

      // Auto-load the agent's session inventory once connected, so sessions
      // created outside this client (CLI, Telegram, another device) show up
      // in the sidebar without a manual refresh.
      void setActiveAgent(agentName);

      // Set up session modes if available
      if (sessionResponse.modes) {
        availableModes.value = (sessionResponse.modes.availableModes || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModeId.value = sessionResponse.modes.currentModeId || '';
      } else {
        availableModes.value = [];
        currentModeId.value = '';
      }

      // Set up session models if available
      if (sessionResponse.models) {
        availableModels.value = (sessionResponse.models.availableModels || []).map(m => ({
          modelId: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModelId.value = sessionResponse.models.currentModelId || '';
      } else {
        availableModels.value = [];
        currentModelId.value = '';
      }

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      // Tear down whichever side of the connection is live. The bridge owns
      // the spawned process once it exists, so prefer disconnecting it.
      // Otherwise (e.g. abort right after spawn but before bridge creation)
      // kill the orphaned local agent directly.
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during createSession cleanup failed:', cleanupErr);
        }
      } else if (spawnedInstance) {
        try {
          await killAgent(spawnedInstance.id);
        } catch (cleanupErr) {
          console.warn('killAgent during createSession cleanup failed:', cleanupErr);
        }
      }
      acpClient = null;
      // Track session creation failure
      trackEvent('SessionCreated', { agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      isLoading.value = false;
      isConnecting.value = false;
      // Clean up startup progress tracking
      if (startupTimer) {
        clearInterval(startupTimer);
        startupTimer = null;
      }
      if (stderrUnlisten) {
        stderrUnlisten();
        stderrUnlisten = null;
      }
    }
  }

  // Resume existing session
  async function resumeSession(
    savedSession: SavedSession,
    options?: { autonomous?: boolean }
  ): Promise<void> {
    isLoading.value = true;
    error.value = null;
    autonomous.value = options?.autonomous ?? false;
    replayAgentName = savedSession.agentName;
    // The tail cache is keyed by agent+session — known before any network
    // work. Hydrate synchronously so the newest known message paints while
    // the connect + replay run; the replay streams into the merge buffer.
    cacheScope = { agent: savedSession.agentName, sessionId: savedSession.sessionId };
    historyCacheNote.value = null;
    replayMerge = null;
    hydrateHistoryCache(savedSession.agentName, savedSession.sessionId);

    try {
      const configStore = useConfigStore();
      const agentConfig: AgentConfig | undefined = configStore.getAgent(savedSession.agentName);
      if (!agentConfig) {
        throw new Error(`Agent '${savedSession.agentName}' not found in config`);
      }

      // Create ACP client bridge (transport selected based on agent config).
      acpClient = await createAcpClient({
        name: savedSession.agentName,
        config: agentConfig,
      });
      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket dropped while idle,
      // local agent process crashed) so the UI doesn't sit on a stale
      // "connected" view forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };

      // Route bridge permission requests through the autonomous/timeout path.
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          handlePermissionRequest(newValue ?? null);
        },
        { immediate: true }
      );

      // Initialize connection
      const initResponse = await initializeClient(acpClient);

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      // Clear messages BEFORE loadSession - the agent will stream replay via
      // notifications. A hydrated tail stays on screen instead: its replay
      // accumulates in the merge buffer and swaps in at resolve.
      if (!replayMerge) {
        messages.value = [];
        toolCalls.value.clear();
      }

      // Try to load existing session - may fail with auth_required
      try {
        await acpClient.loadSession({
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          mcpServers: [],
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');
        
        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          
          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, savedSession.agentName);
          
          if (!selectedMethodId) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }
          
          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          // Retry loading session after auth
          await acpClient.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      // `session/load` resolved — the replay is the truth. Swap the buffered
      // transcript in (or drop a diverged cache) before going "connected".
      settleReplayMerge();

      currentSession.value = savedSession;
      isConnected.value = true;
      // Messages already populated by session/update notifications during loadSession

      useActivityStore().recordEntry({
        kind: 'session-open',
        agentName: savedSession.agentName,
        sessionId: savedSession.sessionId,
        cwd: savedSession.cwd,
        title: savedSession.title,
        detail: 'resumed',
      });

      // Track successful session resume
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'true' });

      // Same auto-load as a fresh connect: the sidebar should mirror the
      // agent's whole inventory, not just what this client created.
      void setActiveAgent(savedSession.agentName);

      // Update last accessed time
      savedSession.lastUpdated = Date.now();
      await saveSessionsToStore();

    } catch (e) {
      // A replay that died mid-flight leaves the cached tail rendered —
      // marked stale rather than silently dropped.
      abortReplayMerge();
      error.value = e instanceof Error ? e.message : String(e);
      const message = error.value;
      const activity = useActivityStore();
      if (/already open in another process|session_locked/i.test(message)) {
        // The agent refused because another process holds the session (Devin
        // reports the holder PID). Surface it as a lock, not as a generic error.
        activity.recordEntry({
          kind: 'lock',
          agentName: savedSession.agentName,
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          title: savedSession.title,
          detail: message,
        });
      } else {
        activity.recordEntry({
          kind: 'error',
          agentName: savedSession.agentName,
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          title: savedSession.title,
          detail: message,
        });
      }
      // Disconnect the bridge if it was created — otherwise we leak the
      // spawned stdio process or open WebSocket on initialize/loadSession
      // failure.
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during resumeSession cleanup failed:', cleanupErr);
        }
        acpClient = null;
      }
      // Track session resume failure
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      isLoading.value = false;
    }
  }

  // Send prompt
  async function sendPrompt(text: string, attachments: Attachment[] = []): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    if (!text && attachments.length === 0) {
      return;
    }

    // Add user message (attachments kept as metadata so the transcript shows
    // what went out, including a thumbnail for images).
    messages.value.push({
      id: uuid(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: attachments.map(({ name, kind, mimeType, size, previewUrl }) => ({
        name, kind, mimeType, size, previewUrl,
      })),
    });

    // Persist the turn's files against its user-turn ordinal so a later
    // `session/load` replay can restore them — agents do not imprint image
    // bytes into the history they stream back. Best-effort: a failed write
    // must not stall the prompt.
    if (attachments.length) {
      const userTurnIndex = messages.value.reduce(
        (n, m) => n + (m.role === 'user' ? 1 : 0),
        0
      );
      void recordTurnAttachments(
        attachmentScope(currentSession.value.sessionId),
        userTurnIndex,
        attachments
      );
    }

    isLoading.value = true;
    const activity = useActivityStore();
    activity.recordEntry({
      kind: 'turn-start',
      agentName: currentSession.value.agentName,
      sessionId: currentSession.value.sessionId,
      cwd: currentSession.value.cwd,
      title: currentSession.value.title,
      detail: text.slice(0, 120),
    });
    try {
      const response = await acpClient.prompt({
        sessionId: currentSession.value.sessionId,
        prompt: promptContentBlocks(text, attachments),
      });

      console.log('Prompt completed:', response.stopReason);
      activity.recordEntry({
        kind: 'turn-end',
        agentName: currentSession.value.agentName,
        sessionId: currentSession.value.sessionId,
        cwd: currentSession.value.cwd,
        title: currentSession.value.title,
        detail: response.stopReason || 'unknown',
      });

      // Track prompt sent
      trackEvent('PromptSent', { 
        messageLength: String(text.length),
        stopReason: response.stopReason || 'unknown',
      });

      // Update session title if it's the first message
      if (messages.value.length === 2 && currentSession.value) {
        currentSession.value.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
        currentSession.value.lastUpdated = Date.now();
        await saveSessionsToStore();
      }
    } catch (e) {
      activity.recordEntry({
        kind: 'error',
        agentName: currentSession.value.agentName,
        sessionId: currentSession.value.sessionId,
        cwd: currentSession.value.cwd,
        title: currentSession.value.title,
        detail: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      isLoading.value = false;
    }
  }

  // Cancel current operation
  async function cancelOperation(): Promise<void> {
    if (!acpClient || !currentSession.value) return;
    
    await acpClient.cancel({
      sessionId: currentSession.value.sessionId,
    });
  }

  // Cancel ongoing connection attempt
  async function cancelConnection(): Promise<void> {
    connectionAborted = true;
    
    // Cancel auth selection if pending
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
    
    // Disconnect if client exists
    if (acpClient) {
      try {
        await acpClient.disconnect();
      } catch (e) {
        console.error('Error disconnecting:', e);
      }
      acpClient = null;
    }
    
    isLoading.value = false;
    isConnecting.value = false;
    error.value = null;
    replayMerge = null;
    historyCacheNote.value = null;
  }

  // Handle permission response
  function resolvePermission(optionId: string): void {
    clearPermissionTimer();
    pendingPermission.value = null;
    if (acpClient) {
      acpClient.resolvePermission(optionId);
    }
  }

  function cancelPermission(): void {
    clearPermissionTimer();
    pendingPermission.value = null;
    if (acpClient) {
      acpClient.cancelPermission();
    }
  }

  // Disconnect current session
  async function disconnect(): Promise<void> {
    const agentName = currentSession.value?.agentName || 'unknown';
    const sessionStart = currentSession.value?.lastUpdated || Date.now();
    const sessionDuration = Math.round((Date.now() - sessionStart) / 1000);
    
    if (acpClient) {
      await acpClient.disconnect();
      acpClient = null;
    }
    
    // Track session disconnect
    trackEvent('SessionDisconnected', { 
      agentName,
      sessionDurationSeconds: String(sessionDuration),
      messageCount: String(messages.value.length),
    });
    
    currentSession.value = null;
    isConnected.value = false;
    // The open-session pointer must die with the disconnect — otherwise the
    // next boot would auto-resume a session the user explicitly closed.
    void saveSessionsToStore();
    // The URL pointer dies with it: `?s=...` names the OPEN chat, and after a
    // disconnect there is none (a stale ?s would resurrect the chat on F5).
    setSessionInUrl('', null);
    // Last chance to keep the tail: the transcript is dropped below.
    flushHistoryNow();
    replayMerge = null;
    historyCacheNote.value = null;
    cacheScope = null;
    messages.value = [];
    toolCalls.value.clear();
    clearPermissionTimer();
    pendingPermission.value = null;
    autonomous.value = false;
    availableModes.value = [];
    currentModeId.value = '';
    availableCommands.value = [];
    availableModels.value = [];
    currentModelId.value = '';
  }

  // Delete saved session
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
    savedSessions.value = savedSessions.value.filter(s => s.id !== sessionId);
    await saveSessionsToStore();
    // The panel's attachment record for that session goes too — otherwise a
    // different session that later reuses the same id would inherit files.
    if (doomed)
      void forgetSessionAttachments(`${doomed.agentName}::${doomed.sessionId}`);
  }

  // Set session mode
  async function setMode(modeId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    
    await acpClient.setMode({
      sessionId: currentSession.value.sessionId,
      modeId,
    });
    
    // Optimistically update the current mode
    currentModeId.value = modeId;
  }

  // Set session model
  async function setModel(modelId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    
    await acpClient.unstable_setSessionModel({
      sessionId: currentSession.value.sessionId,
      modelId,
    });
    
    // Optimistically update the current model
    currentModelId.value = modelId;
  }

  function clearError() {
    error.value = null;
  }

  /**
   * Foreground reconnect: when the user returns to the app and we're
   * disconnected (because the OS froze the WebView, the NAT killed the TCP
   * connection, or the network changed), silently re-attach to the saved
   * session if possible.
   *
   * Returns `true` if a reconnect was attempted, `false` if there was
   * nothing to do (no saved session, already connected/connecting, agent
   * doesn't advertise session-load support, etc.).
   *
   * Errors are surfaced via `error.value` exactly like a manual resume
   * would; the caller doesn't need to handle them.
   */
  async function tryReconnect(): Promise<boolean> {
    // Already connected or already trying — leave it alone.
    if (isConnected.value || isConnecting.value || isLoading.value) {
      return false;
    }
    // No prior session to reconnect to.
    const session = currentSession.value;
    if (!session) {
      return false;
    }
    // Bridge already exists (race with another reconnect in flight).
    if (acpClient) {
      return false;
    }
    // Agent must support `session/load` for resume to be meaningful;
    // otherwise we'd just create a fresh session, which is a strictly
    // user-initiated action.
    if (!session.supportsLoadSession) {
      return false;
    }

    // Clear the stale "Connection lost" banner up-front so the UI shows
    // an honest "Reconnecting…" state instead of a contradictory red
    // banner during the attempt. If the reconnect ultimately fails, the
    // catch below restores a real error message.
    error.value = null;
    isReconnecting.value = true;
    try {
      await resumeSession(session);
      return true;
    } catch (e) {
      // `resumeSession`'s own catch already wrote `error.value`; nothing
      // more to do here. Returning true so the caller knows we tried.
      console.warn('Foreground reconnect failed:', e);
      return true;
    } finally {
      isReconnecting.value = false;
    }
  }

  return {
    // State
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
    supportsListSessions,
    supportsImages,
    isSyncingSessions,
    syncError,
    sessionListUnsupported,
    lastAgentName,
    activeAgentName,
    sidebarLoading,
    lastSync,
    historyCacheNote,
    hiddenSessionPrefixes,

    // Computed
    hasActiveSession,
    messageList,
    toolCallList,
    resumableSessions,
    visibleSessions,

    // Actions
    initStore,
    createSession,
    resumeSession,
    sendPrompt,
    cancelOperation,
    cancelConnection,
    resolvePermission,
    cancelPermission,
    setAutonomous,
    setPermissionTimeout,
    selectAuthMethod,
    cancelAuthSelection,
    disconnect,
    deleteSession,
    setMode,
    setModel,
    clearError,
    tryReconnect,
    syncAgentSessions,
    refreshAgentSessions,
    setActiveAgent,
    setHiddenSessionPrefixes,

    // Expose client for permission handling
    get acpClient() { return acpClient; },
  };
});
