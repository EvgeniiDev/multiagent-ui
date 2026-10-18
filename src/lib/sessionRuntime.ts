import { readSharedHistoryCache, writeSharedHistoryCache } from './historySharedCache';
// Per-session runtime: everything one open chat tab needs — its ACP client,
// transcript, tool calls, permission state, modes/models, startup progress
// and the tail-cache replay merge. The session store creates one runtime per
// open tab, so several sessions stay live in parallel (the ws bridge routes
// frames by sessionId to the socket that claimed them; a stdio agent gets one
// spawned process per tab).
import { ref, computed, watch } from 'vue';
import { getAppVersion } from './host';
import { uuid } from './uuid';
import type { SavedSession, ChatMessage, ToolCallInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig, Attachment, AttachmentMeta, MessageSegment } from './types';
import { getTransportKind } from './types';
import { attachmentFromContentBlock } from './attachments';
import { markPromptRecorded } from './promptError';
import { recordTurnAttachments, turnAttachments, resolveCachedBytes } from './attachmentHistory';
import { readHistoryCache, storeHistoryCacheEntry, type HistoryCacheEntry, writeHistoryCache, dropHistoryCache } from './historyCache';
import { AcpClientBridge, createAcpClient } from './acp-bridge';
import { onAgentStderr, spawnAgent, killAgent } from './host';
import { isDesktop } from './platform';
import { useConfigStore } from '../stores/config';
import { useActivityStore } from '../stores/activity';
import type { SessionNotification, AuthMethod, ContentBlock } from '@agentclientprotocol/sdk';

const PROTOCOL_VERSION = 1;

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
export async function initRuntimeVersion(): Promise<void> {
  try {
    appVersion = await getAppVersion();
  } catch (e) {
    console.warn('Failed to get app version:', e);
  }
}

/**
 * The `initialize` handshake shared by runtime connections and the store's
 * transient session-list client. Only Tauri desktop has real filesystem
 * access; mobile and web cannot fulfil readTextFile / writeTextFile RPCs.
 */
export function initializeHandshake(client: AcpClientBridge) {
  const canAccessFs = isDesktop();
  return client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: canAccessFs,
        writeTextFile: canAccessFs,
      },
    },
    clientInfo: {
      name: 'multiagent-ui',
      title: 'Multiagent UI',
      version: appVersion,
    },
  });
}

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

/** Services the runtime borrows from the surrounding app. */
export interface RuntimeDeps {
  /** Show the auth-method picker; resolves with the chosen id or null. */
  requestAuth(methods: AuthMethod[], agentName: string): Promise<string | null>;
  /** Persist sessions.json (inventory + open-tab pointers). */
  persistSessions(): Promise<void>;
  /** A `session/update` landed on this runtime — the store marks tabs unread. */
  notifyActivity(runtime: SessionRuntime): void;
}

export type SessionRuntime = ReturnType<typeof createSessionRuntime>;

/**
 * A runtime as seen through the store's reactive `openTabs` array: Vue's
 * deep-reactive ref unwraps every Ref field on access, so `rt.isLoading`
 * is a plain `boolean` (writable — writes land on the underlying ref) and
 * `rt.session` is `SavedSession | null`. Components and the orchestrator
 * use this view; inside the runtime's own closure the raw refs rule.
 */
export type SessionTab = import('vue').UnwrapRef<SessionRuntime>;

export function createSessionRuntime(deps: RuntimeDeps) {
  // Identity — the tab's own key parts.
  const id = uuid();
  /** Agent this runtime's session belongs to (set before any replay starts). */
  const agentName = ref('');

  // Transcript state
  const session = ref<SavedSession | null>(null);
  /** The SavedSession this tab is bound to — set the moment resume/create
   *  knows its target, before `session` lands at `session/load` resolve.
   *  Tabs whose connect failed still carry it: the tab strip shows the
   *  title, the click dedupes, persistence and `?s=` keep pointing at it. */
  const descriptor = ref<SavedSession | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const toolCalls = ref<Map<string, ToolCallInfo>>(new Map());
  const isConnected = ref(false);
  const isLoading = ref(false);
  // session/load replays historical frames even when no tail cache exists.
  // Keep them in the transcript without recording them as new live work.
  let loadingHistory = false;
  const isConnecting = ref(false);
  // True while a foreground reconnect attempt is in flight. Distinct from
  // `isConnecting` (which is the multi-phase initial spawn/connect path):
  // reconnects skip the spawn/stderr-progress UI and just need a small
  // "Reconnecting…" indicator.
  const isReconnecting = ref(false);
  const error = ref<string | null>(null);
  const pendingPermission = ref<PermissionRequest | null>(null);
  /** New content arrived while this tab wasn't active (or while hidden). */
  const unread = ref(false);
  /**
   * Autonomous run: when true the client answers `session/request_permission`
   * itself with the allow-once option the agent offered (no dialog) and
   * writes a `permission` audit entry per auto-approval. Per-run state —
   * set on `create`/`resume` via `options.autonomous`, never a global toggle.
   */
  const autonomous = ref(false);
  /** Real timeout handle for the currently pending permission request. */
  let permissionTimer: ReturnType<typeof setTimeout> | null = null;

  // Session modes
  const availableModes = ref<SessionMode[]>([]);
  const currentModeId = ref<string>('');

  // Slash commands
  const availableCommands = ref<SlashCommand[]>([]);

  // Session models
  const availableModels = ref<ModelInfo[]>([]);
  const currentModelId = ref<string>('');

  // Live context meter — the agent's own `usage_update` (tokens used against
  // the window); null until the agent reports. Ledger writes elsewhere also
  // consume that frame, this is the per-tab composer display state.
  const contextUsed = ref<number | null>(null);
  const contextSize = ref<number | null>(null);

  // Capabilities this runtime's agent announced at initialize.
  const supportsListSessions = ref(false);
  /** Agent accepts ACP `image` content blocks (promptCapabilities.image). */
  const supportsImages = ref(false);
  const sessionListUnsupported = ref(false);

  // Connection cancellation
  let connectionAborted = false;

  // Startup progress tracking
  const startupPhase = ref<string>('starting');
  const startupLogs = ref<string[]>([]);
  const startupElapsed = ref<number>(0);
  let startupTimer: ReturnType<typeof setInterval> | null = null;
  let stderrUnlisten: (() => void) | null = null;

  // Current ACP client — one transport per tab.
  let acpClient: AcpClientBridge | null = null;
  /**
   * Turns in flight on this tab. Normally 0-or-1; `steer` briefly overlaps
   * the cancelled turn with its replacement, so `isLoading` is lifted by a
   * count, not a boolean — the Stop button must survive the handoff.
   */
  let inFlightPrompts = 0;

  // ---- History tail cache (localStorage, write-through) -------------------
  // `session/load` can only replay the WHOLE transcript top-down (no tail
  // parameter, no sequence numbers), so "show the newest instantly" needs a
  // client-side copy. `acp-ui:history:<agent>::<sessionId>` keeps the last
  // ~100 rendered messages; the runtime rewrites it on every settled turn
  // and (throttled) while a replay streams, and reconciles against the
  // fresh replay at `session/load` resolve.
  /**
   * Drives the marker above the feed: 'loading' while a cached tail is on
   * screen and the replay is in flight, 'stale' when the replay died and the
   * tail is all there is, null for a live (or empty) transcript.
   */
  const historyCacheNote = ref<'loading' | 'stale' | null>(null);
  /** Session the cache writes belong to while `session` isn't set. */
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

  const messageList = computed(() => messages.value);
  const toolCallList = computed(() => Array.from(toolCalls.value.values()));
  const hasSession = computed(() => session.value !== null);

  /** Stop handle for the permission-request watcher on the live client. */
  let permissionWatchStop: (() => void) | null = null;
  function watchPermissionRequests(): void {
    permissionWatchStop?.();
    permissionWatchStop = watch(
      () => acpClient?.pendingPermissionRequest.value,
      (newValue) => {
        handlePermissionRequest(newValue ?? null);
      },
      { immediate: true }
    );
  }

  /**
   * Initialize a client and record which optional session features the agent
   * has.
   */
  async function initializeClient(client: AcpClientBridge) {
    const initResponse = await initializeHandshake(client);
    supportsListSessions.value = !!initResponse.agentCapabilities?.sessionCapabilities?.list;
    sessionListUnsupported.value = !supportsListSessions.value;
    // Agents announce whether they accept image content blocks; attaching an
    // image to an agent that doesn't is a silent no-op on its side.
    supportsImages.value = !!initResponse.agentCapabilities?.promptCapabilities?.image;
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

  // Handle an unexpected transport close (e.g. WebSocket dropped while idle,
  // local agent process exited). The bridge has already rejected any
  // in-flight requests; we just need to tear down UI state so the user gets
  // a clear "disconnected" signal instead of a stale "connected" view —
  // and arm the auto-reconnect loop so they don't have to ask for it.
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
    // Auto-reconnect runs through `resume`, so `session/load` re-claims the
    // session's socket routing on the bridge automatically. Skipped while
    // the OS reports offline — App.vue's `online` listener fires the
    // foreground `tryReconnect` when the network comes back.
    const saved = session.value ?? descriptor.value;
    const offline =
      typeof navigator !== 'undefined' && navigator.onLine === false;
    if (saved?.supportsLoadSession && !connectionAborted && !offline) {
      armAutoReconnect(saved);
    }
  }

  // ---- Auto-reconnect on unexpected close -----------------------------------
  // Backoff: 1.5 s doubling up to a 30 s cap, retried forever — a bridge
  // restart or a NAT drop should not leave tabs dead until the user notices.
  // Only fires on UNEXPECTED closes: `disconnect()` unlistens onClose before
  // closing, so voluntary teardowns never reach here.
  const AUTO_RECONNECT_BASE_MS = 1500;
  const AUTO_RECONNECT_MAX_MS = 30_000;
  let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let autoReconnectAttempts = 0;

  function disarmAutoReconnect(): void {
    if (autoReconnectTimer !== null) {
      clearTimeout(autoReconnectTimer);
      autoReconnectTimer = null;
    }
  }

  function armAutoReconnect(saved: SavedSession): void {
    disarmAutoReconnect();
    const delay = Math.min(
      AUTO_RECONNECT_BASE_MS * 2 ** autoReconnectAttempts,
      AUTO_RECONNECT_MAX_MS
    );
    autoReconnectAttempts += 1;
    isReconnecting.value = true;
    autoReconnectTimer = setTimeout(() => {
      autoReconnectTimer = null;
      void autoReconnectAttempt(saved);
    }, delay);
  }

  async function autoReconnectAttempt(saved: SavedSession): Promise<void> {
    // Another path already reconnected (foreground tryReconnect, a sidebar
    // click → openTab → resume) or the tab went away while the timer slept.
    if (
      connectionAborted ||
      acpClient ||
      isConnected.value ||
      isLoading.value ||
      isConnecting.value
    ) {
      isReconnecting.value = false;
      return;
    }
    try {
      await resume(saved);
      autoReconnectAttempts = 0;
      isReconnecting.value = false;
    } catch {
      if (connectionAborted) {
        isReconnecting.value = false;
      } else {
        armAutoReconnect(saved);
      }
    }
  }

  // ---- Autonomous permission handling --------------------------------------
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
      agentName: session.value?.agentName ?? agentName.value ?? 'unknown',
      sessionId: request.sessionId || session.value?.sessionId,
      cwd: session.value?.cwd,
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
   * Autonomous sessions never populate `pendingPermission` (so no dialog
   * mounts) — they answer immediately and audit. Manual sessions publish
   * the request for the dialog and arm the timeout. A `null` report means
   * the request settled elsewhere: drop the dialog and the timer.
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
    deps.notifyActivity(runtimeApi);
  }

  /** Enable/disable the autonomous run for this session. */
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

  /** Attachment records are keyed `agent::sessionId`. */
  function attachmentScope(sessionId: string): string {
    return `${agentName.value || session.value?.agentName || ''}::${sessionId}`;
  }

  /** Copy recoverable fields from `src` into `dst` when `dst` lacks them. */
  function fillAttachment(dst: AttachmentMeta, src: AttachmentMeta): void {
    if (!dst.previewUrl && src.previewUrl) dst.previewUrl = src.previewUrl;
    if (!dst.body && src.body) dst.body = src.body;
    if (!dst.cachePath && src.cachePath) dst.cachePath = src.cachePath;
    if (!dst.uri && src.uri) dst.uri = src.uri;
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
    if (existing) {
      fillAttachment(existing, meta);
      return;
    }
    msg.attachments.push(meta);
    // Position the block where it arrived in the stream; a deduped re-send
    // keeps the first position instead of rendering twice.
    (msg.segments ??= []).push({ kind: 'attachment', index: msg.attachments.length - 1 });
  }

  /**
   * The last text segment still open for appends, or a fresh one when a
   * non-text part intervened — this is what keeps narration sent after a tool
   * call from gluing onto the previous paragraph's tail without a separator.
   */
  function openTextSegment(msg: ChatMessage): MessageSegment & { kind: 'text' } {
    const segs = (msg.segments ??= []);
    const last = segs[segs.length - 1];
    if (last?.kind === 'text') return last;
    const seg: MessageSegment & { kind: 'text' } = { kind: 'text', text: '' };
    segs.push(seg);
    return seg;
  }

  /** Last assistant message in `sink`, creating one when the turn's first
   *  frame isn't text (a tool call, a plan, a stray update). */
  function openAssistantMessage(sink: ChatMessage[]): ChatMessage {
    const last = sink[sink.length - 1];
    if (last?.role === 'assistant') return last;
    const msg: ChatMessage = {
      id: uuid(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
    };
    sink.push(msg);
    return msg;
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

  let sessionMetadataDirty = false;

  /** Persist the rendered tail under `cacheScope`. Never throws. */
  function flushHistoryNow(): void {
    if (historyFlushTimer) {
      clearTimeout(historyFlushTimer);
      historyFlushTimer = null;
    }
    lastHistoryFlushAt = Date.now();
    if (!cacheScope || messages.value.length === 0 || loadingHistory || replayMerge || historyCacheNote.value) return;
    if (sessionMetadataDirty) {
      sessionMetadataDirty = false;
      void deps.persistSessions();
    }
    const entry = writeHistoryCache(cacheScope.agent, cacheScope.sessionId, messages.value);
    if (entry) void writeSharedHistoryCache(cacheScope.agent, cacheScope.sessionId, entry);
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
    // Arrival order too — but only when BOTH sides carry it: tails cached by
    // pre-segments builds must still align with a segmented replay instead of
    // being dropped as diverged.
    if (a.segments && b.segments) {
      const seg = (m: ChatMessage) => (m.segments ?? [])
        .map((s) => s.kind === 'tool' ? `t:${s.toolCallId}`
          : s.kind === 'text' ? `x:${s.text.length}`
          : s.kind === 'attachment' ? `a:${s.index}` : 'p')
        .join('|');
      if (seg(a) !== seg(b)) return false;
    }
    if ((a.plan?.length ?? 0) !== (b.plan?.length ?? 0)) return false;
    const at = (m: ChatMessage) =>
      (m.attachments ?? []).map((x) => `${x.kind}:${x.name}`).join(' ');
    return at(a) === at(b);
  }

  /**
   * Render the cached tail synchronously, BEFORE the connect/replay work of
   * `resume`. Arms `replayMerge` so `handleSessionUpdate` routes the
   * coming replay into the side buffer. Returns false when nothing usable
   * is cached (the caller then takes the old clear-and-stream path).
   */
  function hydrateHistoryCache(agent: string, sessionId: string, entry: HistoryCacheEntry | null = readHistoryCache(agent, sessionId)): boolean {
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
    replayMerge = { sessionId, cached, anchorIdx, buffer: replayMerge?.buffer ?? [] };
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
    for (let ai = replayed.length - 1; anchor && ai >= 0; ai--) {
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
    if (cached.length && base < 0) {
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

  /**
   * Result text is not in the SDK's typed union — pi-acp forwards it on
   * tool frames as `rawOutput`, ACP `content` text blocks, or (bash)
   * `_meta.terminal_output` deltas. All three are plain strings here;
   * anything else is ignored. Deltas append, full snapshots replace.
   */
  function toolOutputText(frame: Record<string, unknown>): { text: string; append: boolean } | null {
    const meta = frame._meta as Record<string, unknown> | undefined;
    const termOut = (meta?.terminal_output ?? meta?.terminalOutput) as
      | { data?: unknown }
      | undefined;
    if (typeof termOut?.data === 'string' && termOut.data) {
      return { text: termOut.data, append: true };
    }
    const raw = frame.rawOutput;
    if (typeof raw === 'string' && raw) return { text: raw, append: false };
    const content = frame.content as Array<{ type?: string; content?: { type?: string; text?: unknown } }> | undefined;
    if (Array.isArray(content)) {
      const texts = content
        .map((b) => (b?.content?.type === 'text' && typeof b.content.text === 'string' ? b.content.text : ''))
        .filter(Boolean);
      if (texts.length) return { text: texts.join(''), append: false };
    }
    return null;
  }

  function mergeToolOutput(tc: ToolCallInfo, frame: Record<string, unknown>): void {
    const out = toolOutputText(frame);
    if (!out) return;
    tc.rawOutput = out.append ? (tc.rawOutput ?? '') + out.text : out.text;
  }

  /** Session update handler: routes agent_message_chunk / tool_call /
   * tool_call_update frames into messages + the toolCalls map. */
  function handleSessionUpdate(notification: SessionNotification) {
    const update = notification.update;

    // Each tab owns exactly one session, so the only frames this socket
    // should ever see name this session (during `session/load`, before
    // `session` lands, the merge buffer/cache scope identify it). Anything
    // else is cross-talk from the shared bridge — ignore it, but keep
    // `usage_update` since it is ledger data rather than transcript.
    const expectedSessionId =
      replayMerge?.sessionId ?? cacheScope?.sessionId ?? session.value?.sessionId;
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
      if (!foreign) {
        contextUsed.value = Number(untyped.used ?? 0);
        contextSize.value = untyped.size != null ? Number(untyped.size) : null;
      }
      useActivityStore().recordUsage({
        agentName: agentName.value || session.value?.agentName || 'unknown',
        sessionId: notification.sessionId || session.value?.sessionId || 'unknown',
        cwd: foreign ? undefined : session.value?.cwd,
        accounting: 'context',
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

    deps.notifyActivity(runtimeApi);
    // Replayed history and service notifications must not reorder the list.
    if (!loadingHistory && (update.sessionUpdate === 'agent_message_chunk'
        || update.sessionUpdate === 'user_message_chunk')) {
      if (session.value) {
        session.value.lastUpdated = session.value.lastMessageAt = Date.now();
        sessionMetadataDirty = true;
      }
    }

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
          openTextSegment(target).text += update.content.text;
        } else {
          attachContentBlock(target, update.content);
        }
        break;
      }

      case 'agent_message_chunk': {
        // Append to last assistant message or create new
        const target = openAssistantMessage(sink);
        if (update.content.type === 'text') {
          target.content += update.content.text;
          openTextSegment(target).text += update.content.text;
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
        const targetMsg = openAssistantMessage(sink);
        if (!targetMsg.toolCalls) {
          targetMsg.toolCalls = [];
        }
        // `rawInput` (parsed call args) is not in the SDK's typed union yet —
        // forwarded verbatim by the ws bridge, read via safe cast.
        const callRawInput = (update as { rawInput?: unknown }).rawInput;
        const callFrame = update as unknown as Record<string, unknown>;
        const callOutput = toolOutputText(callFrame)?.text;
        targetMsg.toolCalls.push({
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
          rawInput: callRawInput,
          rawOutput: callOutput,
        });
        (targetMsg.segments ??= []).push({ kind: 'tool', toolCallId: update.toolCallId });
        // Also keep in the map for updates
        toolCalls.value.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
          rawInput: callRawInput,
          rawOutput: callOutput,
        });
        if (!loadingHistory) useActivityStore().recordEntry({
          kind: 'tool-call',
          agentName: agentName.value || session.value?.agentName || 'unknown',
          sessionId: notification.sessionId,
          cwd: session.value?.cwd,
          title: update.title,
          detail: update.kind || 'other',
        });
        break;
      }

      case 'tool_call_update': {
        // Late-arriving call args ride the same frame (safe cast — not in
        // the SDK's typed union yet). Merge, don't overwrite blindly: an
        // update without rawInput must not clear what tool_call set.
        const updateRawInput = (update as { rawInput?: unknown }).rawInput;
        const updateFrame = update as unknown as Record<string, unknown>;
        const existing = toolCalls.value.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          if (updateRawInput !== undefined) existing.rawInput = updateRawInput;
          mergeToolOutput(existing, updateFrame);
          // Also update in the message's toolCalls array
          for (const msg of sink) {
            if (msg.toolCalls) {
              const tc = msg.toolCalls.find(t => t.toolCallId === update.toolCallId);
              if (tc) {
                if (update.status) tc.status = update.status;
                if (update.title) tc.title = update.title;
                if (updateRawInput !== undefined) tc.rawInput = updateRawInput;
                mergeToolOutput(tc, updateFrame);
              }
            }
          }
        } else {
          // An update for a call that was never announced (the agent skipped
          // the `tool_call` frame, or frames reordered): materialize the chip
          // rather than drop the output the frame carries. The map gets its
          // own object — later updates merge into it and the message copy
          // separately, exactly like the announced-call path above.
          const targetMsg = openAssistantMessage(sink);
          targetMsg.toolCalls ??= [];
          const info: ToolCallInfo = {
            toolCallId: update.toolCallId,
            title: update.title || 'tool call',
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations ?? undefined,
            rawInput: updateRawInput,
          };
          mergeToolOutput(info, updateFrame);
          targetMsg.toolCalls.push(info);
          (targetMsg.segments ??= []).push({ kind: 'tool', toolCallId: update.toolCallId });
          toolCalls.value.set(update.toolCallId, { ...info });
        }
        break;
      }

      case 'plan': {
        // Whole-snapshot updates: keep the latest entries, pin the card where
        // the agent first published it this turn.
        const targetMsg = openAssistantMessage(sink);
        targetMsg.plan = update.entries;
        const segs = (targetMsg.segments ??= []);
        if (!segs.some((s) => s.kind === 'plan')) segs.push({ kind: 'plan' });
        break;
      }

      case 'config_option_update':
        // Experimental ACP surface — no picker UI consumes it yet. Ledger
        // entry keeps the frame observable instead of silently dropped.
        if (!loadingHistory) useActivityStore().recordEntry({
          kind: 'sync',
          agentName: agentName.value || session.value?.agentName || 'unknown',
          sessionId: notification.sessionId,
          cwd: session.value?.cwd,
          title: 'config options updated',
        });
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
        if (!loadingHistory) useActivityStore().recordEntry({
          kind: 'sync',
          agentName: agentName.value || session.value?.agentName || 'unknown',
          sessionId: notification.sessionId,
          cwd: session.value?.cwd,
          title: info.title ?? session.value?.title,
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

  // Create new session on this runtime's connection.
  async function create(
    agent: string,
    cwd: string,
    options?: { autonomous?: boolean }
  ): Promise<SavedSession> {
    isLoading.value = true;
    isConnecting.value = true;
    connectionAborted = false;
    error.value = null;
    // Autonomous is per-run, not a global toggle: reset on every connect so
    // a manual session never inherits it from a previous run.
    autonomous.value = options?.autonomous ?? false;
    // Attachment records are keyed agent::session — known before the session
    // id exists, so the replay merge can look them up while `session`
    // is still null.
    agentName.value = agent;
    // No session id yet — cache writes wait until `session/new` returns it.
    cacheScope = null;
    historyCacheNote.value = null;
    replayMerge = null;

    // Look up the agent's transport kind so we know whether to do the
    // stdio-only startup choreography (spawn → stderr progress) or the
    // streamlined remote path (just open a network transport).
    const configStore = useConfigStore();
    const agentConfig: AgentConfig | undefined = configStore.getAgent(agent);
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
        throw new Error(`Agent '${agent}' not found in config`);
      }

      if (!isRemote) {
        // For stdio agents we need the spawned process's id up front so the
        // stderr listener can filter on it (multiple agents may be running
        // concurrently). We spawn here, hand the resulting AgentInstance to
        // a StdioTransport, then build the bridge from that transport.
        startupPhase.value = 'starting';
        const agentInstance = await spawnAgent(agent);
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
        acpClient = await createAcpClient({ name: agent, config: agentConfig });
      }

      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket drop while idle)
      // to the UI so users don't sit on a stale "connected" state forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };

      // Route bridge permission requests through the autonomous/timeout path.
      watchPermissionRequests();

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
          const selectedMethodId = await deps.requestAuth(availableAuthMethods, agent);

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
      const saved: SavedSession = {
        id: uuid(),
        agentName: agent,
        sessionId: sessionResponse.sessionId,
        title: folder,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };

      // A fresh session has no replay to validate a tail against — if the
      // agent recycled a sessionId, the old tail must not resurrect as if
      // it were this session's history.
      dropHistoryCache(agent, sessionResponse.sessionId);
      cacheScope = { agent, sessionId: sessionResponse.sessionId };

      session.value = saved;
      descriptor.value = saved;
      // The caller adds this row to the inventory and persists it together
      // with its open-tab pointer after create() returns.

      isConnected.value = true;
      autoReconnectAttempts = 0;
      messages.value = [];
      toolCalls.value.clear();

      const activity = useActivityStore();
      activity.recordEntry({
        kind: 'connected',
        agentName: agent,
        sessionId: sessionResponse.sessionId,
        cwd,
        title: folder,
      });
      activity.recordEntry({
        kind: 'session-open',
        agentName: agent,
        sessionId: sessionResponse.sessionId,
        cwd,
        title: folder,
        detail: 'new session',
      });


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

      // The agent's configured default mode replaces whatever it opened
      // with — e.g. `devin acp` always starts in accept-edits while this
      // deployment wants bypass, and its bridge env cannot change that
      // (`devin acp` ignores DEVIN_PERMISSION_MODE; verified 3000.11.3).
      // Best-effort: a refused switch leaves the session usable in the
      // agent-reported mode.
      await applyDefaultMode(agentConfig, sessionResponse);

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

      return saved;

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
          console.warn('disconnect during create cleanup failed:', cleanupErr);
        }
      } else if (spawnedInstance) {
        try {
          await killAgent(spawnedInstance.id);
        } catch (cleanupErr) {
          console.warn('killAgent during create cleanup failed:', cleanupErr);
        }
      }
      acpClient = null;

      throw e;
    } finally {
      // `isLoading` is owned by `inFlightPrompts` (sendPrompt :1576) — a
      // create finishing while a prompt is in flight must not hide Stop.
      if (inFlightPrompts === 0) isLoading.value = false;
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

  // Resume existing session on this runtime's connection.
  async function resume(
    savedSession: SavedSession,
    options?: { autonomous?: boolean }
  ): Promise<void> {
    isLoading.value = true;
    // Keep the previous failure until session/load verifies recovery. A
    // reconnect attempt alone is not evidence that the fault disappeared.
    // A fresh resume supersedes any earlier cancel — without the reset, a
    // tab resumed after cancelConnection would carry the aborted flag
    // forever and the auto-reconnect loop would never arm for it.
    connectionAborted = false;
    disarmAutoReconnect();
    autonomous.value = options?.autonomous ?? false;
    agentName.value = savedSession.agentName;
    descriptor.value = savedSession;
    // The tail cache is keyed by agent+session — known before any network
    // work. Hydrate synchronously so the newest known message paints while
    // the connect + replay run; the replay streams into the merge buffer.
    cacheScope = { agent: savedSession.agentName, sessionId: savedSession.sessionId };
    historyCacheNote.value = null;
    // Keep replay off the DOM even on a cache miss: its early chunks are
    // oldest messages, not the newest tail the user opened this chat to see.
    replayMerge = { sessionId: savedSession.sessionId, cached: [], anchorIdx: -1, buffer: [] };
    historyCacheNote.value = 'loading';
    const local = readHistoryCache(savedSession.agentName, savedSession.sessionId);
    hydrateHistoryCache(savedSession.agentName, savedSession.sessionId, local);
    const pendingMerge = replayMerge;
    void readSharedHistoryCache(savedSession.agentName, savedSession.sessionId).then((entry) => {
      if (!entry || replayMerge !== pendingMerge || entry.savedAt <= (local?.savedAt ?? 0)) return;
      storeHistoryCacheEntry(savedSession.agentName, savedSession.sessionId, entry);
      hydrateHistoryCache(savedSession.agentName, savedSession.sessionId, entry);
    });

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
      watchPermissionRequests();

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

      // Try to load existing session - may fail with auth_required.
      // The load result carries the session inventory (models / modes) —
      // same shape as session/new — captured for the parser below.
      const loadHistory = async () => {
        loadingHistory = true;
        try {
          return await acpClient!.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers: [],
          });
        } finally {
          // Failed loads and authentication retries must not suppress later
          // live activity once the historical stream has finished.
          loadingHistory = false;
        }
      };
      let loadResponse: Awaited<ReturnType<AcpClientBridge['loadSession']>> | undefined;
      try {
        loadResponse = await loadHistory();
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');

        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);

          // Prompt user to select auth method
          const selectedMethodId = await deps.requestAuth(availableAuthMethods, savedSession.agentName);

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
          loadResponse = await loadHistory();
        } else {
          throw sessionError;
        }
      }

      // `session/load` resolved — the replay is the truth. Swap the buffered
      // transcript in (or drop a diverged cache) before going "connected".
      settleReplayMerge();

      session.value = savedSession;

      // Session inventory from the load result (modes/models pickers never
      // see it on a resumed session otherwise — only create() parsed it).
      if (loadResponse?.modes) {
        availableModes.value = (loadResponse.modes.availableModes || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModeId.value = loadResponse.modes.currentModeId || '';
      }
      if (loadResponse?.models) {
        availableModels.value = (loadResponse.models.availableModels || []).map(m => ({
          modelId: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModelId.value = loadResponse.models.currentModelId || '';
      }

      isConnected.value = true;
      error.value = null;
      autoReconnectAttempts = 0;
      // Messages already populated by session/update notifications during loadSession

      useActivityStore().recordEntry({
        kind: 'session-open',
        agentName: savedSession.agentName,
        sessionId: savedSession.sessionId,
        cwd: savedSession.cwd,
        title: savedSession.title,
        detail: 'resumed',
      });


      // Opening a session preserves its last message time.
      await deps.persistSessions();

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
          console.warn('disconnect during resume cleanup failed:', cleanupErr);
        }
        acpClient = null;
      }

      throw e;
    } finally {
      // Same ownership rule as create(): a prompt in flight keeps `isLoading`.
      if (inFlightPrompts === 0) isLoading.value = false;
    }
  }

  // Send prompt
  async function sendPrompt(text: string, attachments: Attachment[] = []): Promise<void> {
    if (!acpClient || !session.value) {
      throw new Error('No active session');
    }
    if (!text && attachments.length === 0) {
      return;
    }

    // Add user message (attachments kept as metadata so the transcript shows
    // what went out, including a thumbnail for images). No `segments` here —
    // the replayed twin carries only a text part (agents echo files as
    // markers, not blocks), and a segment-shape mismatch would make
    // `sameMessage` report a false divergence.
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
        attachmentScope(session.value.sessionId),
        userTurnIndex,
        attachments
      );
    }

    session.value.lastUpdated = session.value.lastMessageAt = Date.now();
    void deps.persistSessions();
    isLoading.value = true;
    inFlightPrompts += 1;
    const activity = useActivityStore();
    activity.recordEntry({
      kind: 'turn-start',
      agentName: session.value.agentName,
      sessionId: session.value.sessionId,
      cwd: session.value.cwd,
      title: session.value.title,
      detail: text.slice(0, 120),
    });
    try {
      const response = await acpClient.prompt({
        sessionId: session.value.sessionId,
        prompt: promptContentBlocks(text, attachments),
      });

      console.log('Prompt completed:', response.stopReason);
      activity.recordEntry({
        kind: 'turn-end',
        agentName: session.value.agentName,
        sessionId: session.value.sessionId,
        cwd: session.value.cwd,
        title: session.value.title,
        detail: response.stopReason || 'unknown',
      });


      // Update session title if it's the first message
      if (messages.value.length === 2 && session.value) {
        session.value.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
        sessionMetadataDirty = true;
      }
    } catch (e) {
      activity.recordEntry({
        kind: 'error',
        agentName: session.value.agentName,
        sessionId: session.value.sessionId,
        cwd: session.value.cwd,
        title: session.value.title,
        detail: e instanceof Error ? e.message : String(e),
      });
      // The user turn above stays in the transcript — tag the failure so a
      // caller restoring the composer draft doesn't invite a duplicate resend.
      throw markPromptRecorded(e);
    } finally {
      inFlightPrompts = Math.max(0, inFlightPrompts - 1);
      if (inFlightPrompts === 0) isLoading.value = false;
    }
  }

  /**
   * Mid-run steer: the user typed a message while a turn was still running.
   * Cancel the in-flight turn first — `session/cancel` is a notification and
   * ordering with the next write is guaranteed on the single socket — then
   * send the text as a fresh turn. The cancelled prompt resolves with
   * `stopReason:'cancelled'` on agents that honor it; its ledger entry
   * records `cancelled` honestly. The cancel is best-effort (§R4): an agent
   * that ignores it still gets the new prompt, and we never block on it.
   */
  async function steer(text: string, attachments: Attachment[] = []): Promise<void> {
    if (!acpClient || !session.value) {
      throw new Error('No active session');
    }
    // `isConnected` flips only after `session/new`/`session/load` resolves —
    // gate every prompt path below on it so a programmatic steer during a
    // resume can't fire `session/prompt` mid-load. (The composer can't reach
    // this today: it's disabled while `!isConnected`.)
    if (!isConnected.value) {
      throw new Error('Not connected');
    }
    if (!isLoading.value || inFlightPrompts === 0) {
      return sendPrompt(text, attachments);
    }
    try {
      await acpClient.cancel({ sessionId: session.value.sessionId });
    } catch (e) {
      console.warn('steer: session/cancel failed, sending prompt anyway:', e);
    }
    await sendPrompt(text, attachments);
  }

  // Cancel current operation
  async function cancelOperation(): Promise<void> {
    if (!acpClient || !session.value) return;

    await acpClient.cancel({
      sessionId: session.value.sessionId,
    });
  }

  // Cancel ongoing connection attempt
  async function cancelConnection(): Promise<void> {
    connectionAborted = true;
    disarmAutoReconnect();
    isReconnecting.value = false;

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
    permissionWatchStop?.();
    permissionWatchStop = null;
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

  /**
   * Tear the connection down and drop the transcript. Closing a TAB never
   * deletes the session — the agent keeps it and the sidebar row survives;
   * this only frees the transport.
   */
  async function close(): Promise<void> {
    // Abort an in-flight connect: without this a mid-create close would let
    // `session/new` land on a tab that's already gone.
    connectionAborted = true;
    disarmAutoReconnect();
    isReconnecting.value = false;

    if (acpClient) {
      await acpClient.disconnect();
      acpClient = null;
    }


    isConnected.value = false;
    // Last chance to keep the tail: the transcript is dropped below.
    flushHistoryNow();
    replayMerge = null;
    historyCacheNote.value = null;
    cacheScope = null;
    messages.value = [];
    toolCalls.value.clear();
    clearPermissionTimer();
    permissionWatchStop?.();
    permissionWatchStop = null;
    pendingPermission.value = null;
    autonomous.value = false;
    availableModes.value = [];
    currentModeId.value = '';
    availableCommands.value = [];
    availableModels.value = [];
    currentModelId.value = '';
    contextUsed.value = null;
    contextSize.value = null;
  }

  /**
   * Apply the agent's configured `defaultMode` right after `session/new`.
   * Prefers `session/set_mode`; agents that refuse it but expose the mode
   * as a config select (OpenCode-style `configOptions` entries with
   * category/id `mode`) get `session/set_config_option` as a fallback.
   * Failures are logged, never thrown — the fresh session must stay usable
   * in whichever mode the agent reported.
   */
  async function applyDefaultMode(
    agentConfig: AgentConfig,
    sessionResponse: Awaited<ReturnType<AcpClientBridge['newSession']>>
  ): Promise<void> {
    const wanted = agentConfig.defaultMode;
    if (
      !wanted ||
      wanted === currentModeId.value ||
      !availableModes.value.some((m) => m.id === wanted) ||
      !acpClient ||
      !session.value
    ) {
      return;
    }
    const sessionId = session.value.sessionId;
    try {
      await acpClient.setMode({ sessionId, modeId: wanted });
      currentModeId.value = wanted;
      return;
    } catch (e) {
      const modeOption = (sessionResponse.configOptions ?? []).find(
        (o) => o && (o.category === 'mode' || o.id === 'mode')
      );
      const options = modeOption?.options;
      const offers = Array.isArray(options) && options.some(
        // Flat option lists carry `{value}`; grouped selects nest them.
        (entry) => entry && 'value' in entry
          ? entry.value === wanted
          : (entry as { options?: { value: string }[] }).options?.some(
              (o) => o.value === wanted
            )
      );
      if (!modeOption || !offers) {
        console.warn(`default mode '${wanted}' refused:`, e);
        return;
      }
      try {
        await acpClient.setConfigOption({ sessionId, configId: modeOption.id, value: wanted });
        currentModeId.value = wanted;
      } catch (e2) {
        console.warn(`default mode '${wanted}' refused:`, e2);
      }
    }
  }

  // Set session mode
  async function setMode(modeId: string): Promise<void> {
    if (!acpClient || !session.value) {
      throw new Error('No active session');
    }

    await acpClient.setMode({
      sessionId: session.value.sessionId,
      modeId,
    });

    // Optimistically update the current mode
    currentModeId.value = modeId;
  }

  // Set session model
  async function setModel(modelId: string): Promise<void> {
    if (!acpClient || !session.value) {
      throw new Error('No active session');
    }

    await acpClient.unstable_setSessionModel({
      sessionId: session.value.sessionId,
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
   */
  async function tryReconnect(): Promise<boolean> {
    // Verify a socket that LOOKS connected before deciding there's nothing
    // to do: the OS may have suspended the heartbeat while we were
    // backgrounded, leaving a half-open TCP that still reports OPEN.
    // A failed probe aborts the socket — `onTransportClose` runs
    // `handleUnexpectedClose`, which clears acpClient/isConnected so we
    // fall through to the resume path below.
    if (isConnected.value && acpClient) {
      const alive = await acpClient.probe(3_000).catch(() => false);
      if (alive) return false;
      if (!acpClient) {
        // The abort above already ran the unexpected-close teardown —
        // including arming the background reconnect loop. This manual call
        // is the same intent, so fall through and resume now rather than
        // waiting out the backoff.
        disarmAutoReconnect();
        isReconnecting.value = false;
      }
    }
    // Already connected or already trying — leave it alone.
    if (isConnected.value || isConnecting.value || isLoading.value) {
      return false;
    }
    // No prior session to reconnect to. A tab whose first resume failed
    // never got `session` — the descriptor still knows what to retry.
    const s = session.value ?? descriptor.value;
    if (!s) {
      return false;
    }
    // Bridge already exists (race with another reconnect in flight).
    if (acpClient) {
      return false;
    }
    // Agent must support `session/load` for resume to be meaningful;
    // otherwise we'd just create a fresh session, which is a strictly
    // user-initiated action.
    if (!s.supportsLoadSession) {
      return false;
    }

    // The reconnect indicator owns the pending UI. Retain the last error
    // until resume confirms recovery, rather than clearing a failed attempt.
    isReconnecting.value = true;
    try {
      await resume(s);
      return true;
    } catch (e) {
      console.warn('Foreground reconnect failed:', e);
      return true;
    } finally {
      isReconnecting.value = false;
    }
  }

  const runtimeApi = {
    id,
    agentName,

    // State
    session,
    descriptor,
    messages,
    isConnected,
    isLoading,
    isConnecting,
    isReconnecting,
    error,
    pendingPermission,
    autonomous,
    unread,
    availableModes,
    currentModeId,
    availableCommands,
    availableModels,
    currentModelId,
    contextUsed,
    contextSize,
    startupPhase,
    startupLogs,
    startupElapsed,
    supportsListSessions,
    supportsImages,
    sessionListUnsupported,
    historyCacheNote,

    // Computed
    hasSession,
    messageList,
    toolCallList,

    // Actions
    create,
    resume,
    sendPrompt,
    steer,
    cancelOperation,
    cancelConnection,
    resolvePermission,
    cancelPermission,
    setAutonomous,
    setPermissionTimeout,
    close,
    setMode,
    setModel,
    clearError,
    tryReconnect,

    // Expose client for permission handling
    get acpClient() { return acpClient; },
    /** SavedSession this tab is bound to (null until connected). */
    get currentSession() { return session.value; },
  };

  return runtimeApi;
}
