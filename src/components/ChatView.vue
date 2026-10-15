<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount, type Directive } from 'vue';
import { marked, Renderer, type Tokens } from 'marked';
import { useSessionStore } from '../stores/session';
import { useActivityStore } from '../stores/activity';
import { useUiStore } from '../stores/ui';
import { isMobile, isTauriHost } from '../lib/platform';
import { loadKvStore, type KVStore } from '../lib/host';
import { readAttachments, formatBytes, extractReplayedAttachments, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from '../lib/attachments';
import ModePicker from './ModePicker.vue';
import ModelPicker from './ModelPicker.vue';
import ToolCallChip from './ToolCallChip.vue';
import MessageAttachment from './MessageAttachment.vue';
import UiComposerSettings from './ui/UiComposerSettings.vue';
import UiButton from './ui/UiButton.vue';
import UiFullscreen from './ui/UiFullscreen.vue';
import WorkflowPanel from './WorkflowPanel.vue';
import { useWorkflowStore } from '../stores/workflow';
import CommandPalette from './CommandPalette.vue';
import VoiceInput from './VoiceInput.vue';
import type { Attachment, AttachmentMeta, ChatMessage, SlashCommand, ToolCallInfo } from '../lib/types';
import type { SessionTab } from '../lib/sessionRuntime';
import { promptRecorded } from '../lib/promptError';
import type { SttPartial } from '../lib/stt';
import { transcriptSeparator, insertDictation, moveDictationAnchor } from '../lib/dictationText';
import { hydrateMermaid } from '../lib/mermaid';

const props = defineProps<{
  /** The tab's session runtime — one ChatView instance per open tab, kept
   *  alive (v-show) so scroll position and composer draft survive a switch.
   *  Reached through the reactive tabs array, so its ref fields surface
   *  unwrapped (rt.isLoading is a plain boolean). */
  runtime: SessionTab;
}>();

const sessionStore = useSessionStore();
const wfStore = useWorkflowStore();
const uiStore = useUiStore();

// Composer run mode (chat vs workflow) — the workflow store owns it and
// persists it in workflow.json; the side panel v-if's off it.
const RUN_MODES: { id: 'chat' | 'workflow'; name: string }[] = [
  { id: 'chat', name: 'Chat' },
  { id: 'workflow', name: 'Workflow' },
];
const inputText = ref('');
const preparingSend = ref(false);
const messagesContainer = ref<HTMLElement | null>(null);
const commandPaletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);

// Files staged for the next turn, and the last attach error (limits, wrong type).
const attachments = ref<Attachment[]>([]);
const attachError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const composerEl = ref<HTMLTextAreaElement | null>(null);
const composerBox = ref<HTMLElement | null>(null);
const inputContainer = ref<HTMLElement | null>(null);
const inputHeight = ref(0);
const voiceInputRef = ref<InstanceType<typeof VoiceInput> | null>(null);
const voiceOverlayEl = ref<HTMLElement | null>(null);
const rt = props.runtime;
const supportsImages = computed(() => rt.supportsImages);
const imageHint = computed(
  () => `Images and text files (max ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)} / ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}) — Ctrl+V pastes a copied image`
);

// On mobile (iOS/Android) the soft-keyboard's Return key should insert a
// newline like every other native chat app; submitting is the dedicated
// Send button. On desktop, Enter still submits and Shift+Enter newlines.
const submitOnEnter = !isMobile();

// Narrow-viewport signal for the composer — same query as App.vue's
// sidebar-drawer breakpoint. Placeholder text and the desktop-only update
// nag can't be swapped by CSS, so the flag lives here.
const isNarrowLayout = ref(false);
const useDocumentScroll = computed(() => isNarrowLayout.value && !isTauriHost() && sessionStore.activeTabId === rt.id && uiStore.activeView === 'chat');
let savedDocumentTop = 0;
function feedScroller(): HTMLElement | null {
  return useDocumentScroll.value ? document.scrollingElement as HTMLElement | null : messagesContainer.value;
}
function onDocumentScroll() {
  if (!useDocumentScroll.value) return;
  savedDocumentTop = document.scrollingElement?.scrollTop ?? 0;
  onFeedScroll();
}
function onViewportResize() {
  if (useDocumentScroll.value && followBottom.value) void nextTick(pinFeedToBottom);
}
let narrowMql: MediaQueryList | null = null;
function syncNarrowLayout() {
  if (narrowMql) isNarrowLayout.value = narrowMql.matches;
}

// ---------------- Update nag ----------------
//
// Agent CLIs announce their own updates on stderr ("New version available:
// vX (installed vY). Run: npm i -g …") — those lines land in the runtime's
// startup log. Dismissal persists the offered version in preferences.json
// (same KV store the App shell keeps lastCwd in): the same version stays
// hidden, a newer one re-arms the strip.
const NAG_PATTERN = /new version available:\s*v?(\S+)\s*\(installed\s+v?(\S+?)\)/i;

const updateNag = computed(() => {
  for (const line of rt.startupLogs) {
    const m = NAG_PATTERN.exec(line);
    // offered = vX (the version the agent advertises); kept for the
    // dismissal comparison. The strip shows the agent's line verbatim.
    if (m) return { text: line.trim(), offered: m[1] };
  }
  return null;
});

const updateNagDismissed = ref<string | null>(null);

const showUpdateNag = computed(
  () =>
    updateNag.value !== null &&
    !isNarrowLayout.value &&
    updateNagDismissed.value !== updateNag.value.offered
);

let prefsStore: KVStore | null = null;

async function loadUpdateNagDismissal() {
  try {
    prefsStore = await loadKvStore('preferences.json');
    updateNagDismissed.value =
      (await prefsStore.get<string>('updateNagDismissed')) ?? null;
  } catch (e) {
    console.warn('Failed to load update-nag dismissal:', e);
  }
}

async function dismissUpdateNag() {
  const offered = updateNag.value?.offered;
  if (!offered) return;
  updateNagDismissed.value = offered;
  try {
    if (!prefsStore) prefsStore = await loadKvStore('preferences.json');
    await prefsStore.set('updateNagDismissed', offered);
    await prefsStore.save();
  } catch (e) {
    console.warn('Failed to persist update-nag dismissal:', e);
  }
}

// Track expanded thought sections by message id
const expandedThoughts = ref<Set<string>>(new Set());

const messages = computed(() => rt.messageList);

/**
 * One file can reach a message twice: as a real content block (or the panel's
 * own record — both already in `message.attachments`) and as a marker the
 * agent echoed into the text (what `extractReplayedAttachments` finds). Same
 * name+kind is the same file — keep the entry with the recoverable bytes.
 */
function mergeAttachments(
  base: AttachmentMeta[],
  extra: AttachmentMeta[]
): AttachmentMeta[] {
  const out = base.map((a) => ({ ...a }));
  for (const r of extra) {
    const dup = out.find((a) => a.name === r.name && a.kind === r.kind);
    if (!dup) {
      out.push(r);
      continue;
    }
    if (!dup.previewUrl && r.previewUrl) dup.previewUrl = r.previewUrl;
    if (!dup.body && r.body) dup.body = r.body;
    if (dup.previewUrl || dup.body) dup.unavailableReason = undefined;
  }
  return out;
}

/**
 * Messages with their attachments in a renderable shape.
 *
 * A turn sent here carries `attachments` metadata directly. A turn the agent
 * REPLAYED (`session/load`) does not: agents echo the file into the message
 * text as markup, so those markers are pulled back out and turned into the same
 * attachment blocks instead of leaking into the prose.
 *
 * Only the tail window is mapped: `session/load` replays the WHOLE transcript
 * top-down with no pagination, so mapping every message (and parsing its
 * markdown at render time) on each streamed chunk saturates the main thread
 * on long histories. The store keeps the full array — historyCache
 * write-through and the replay merge need it — only the view slices it.
 * Hidden rows cost nothing until scrolling near the top grows the window.
 */
const FEED_WINDOW_INIT = 30;
const FEED_WINDOW_STEP = 50;
// The window auto-extends once the scroll is within this many viewports of
// the top — firing early means a fast flick never hits an empty edge.
const FEED_TOP_VIEWPORTS = 1.5;
const feedWindow = ref(FEED_WINDOW_INIT);

// Messages parked above the rendered window.
const hiddenCount = computed(() =>
  Math.max(0, messages.value.length - feedWindow.value)
);

const renderedMessages = computed(() =>
  messages.value.slice(-feedWindow.value).map((message) => {
    if (message.role !== 'user' || !message.content) {
      return { ...message, attachments: message.attachments ?? [] };
    }
    const { text, attachments: replayed } = extractReplayedAttachments(message.content);
    return {
      ...message,
      content: text,
      attachments: mergeAttachments(message.attachments ?? [], replayed),
    };
  })
);

// renderedMessages is a TAIL slice — this is the index of its first element
// inside the full transcript. The streaming caret derives "last" from the
// FULL list (`windowOffset + idx === messages.length - 1`), so collapsing
// the window can't leave the caret blinking on a merely-last-visible row.
const windowOffset = computed(() =>
  messages.value.length - renderedMessages.value.length
);

/**
 * Ordered render pieces of an assistant message. `segments` carry the true
 * arrival order — a narration block sent between two tool calls renders
 * between them instead of gluing onto the previous paragraph. Messages
 * hydrated from a pre-segments cache entry have none and fall back to the
 * legacy flat order (attachments → chips → one content blob).
 */
type RenderItem =
  | { kind: 'text'; text: string; last: boolean }
  | { kind: 'tool'; tc: ToolCallInfo; last: boolean }
  | { kind: 'attachment'; att: AttachmentMeta; index: number; last: boolean }
  | { kind: 'plan'; last: boolean };

function assistantItems(message: ChatMessage): RenderItem[] {
  const items: RenderItem[] = [];
  const segs = message.segments;
  if (segs?.length) {
    // Attachments no segment claims (only possible when ingestion code paths
    // missed one) keep the old top position instead of vanishing.
    const claimed = new Set(
      segs.flatMap((s) => (s.kind === 'attachment' ? [s.index] : []))
    );
    (message.attachments ?? []).forEach((att, index) => {
      if (!claimed.has(index)) items.push({ kind: 'attachment', att, index, last: false });
    });
    for (const s of segs) {
      if (s.kind === 'text') {
        if (s.text) items.push({ kind: 'text', text: s.text, last: false });
      } else if (s.kind === 'tool') {
        const tc = message.toolCalls?.find((t) => t.toolCallId === s.toolCallId);
        if (tc) items.push({ kind: 'tool', tc, last: false });
      } else if (s.kind === 'attachment') {
        const att = message.attachments?.[s.index];
        if (att) items.push({ kind: 'attachment', att, index: s.index, last: false });
      } else if (s.kind === 'plan' && message.plan?.length) {
        items.push({ kind: 'plan', last: false });
      }
    }
  } else {
    (message.attachments ?? []).forEach((att, index) =>
      items.push({ kind: 'attachment', att, index, last: false }));
    for (const tc of message.toolCalls ?? [])
      items.push({ kind: 'tool', tc, last: false });
    if (message.plan?.length) items.push({ kind: 'plan', last: false });
    if (message.content)
      items.push({ kind: 'text', text: message.content, last: false });
  }
  if (items.length) items[items.length - 1].last = true;
  return items;
}

// Per-attachment disclosure for the replayed file body (keyed message:index).
const expandedAttachments = ref<Set<string>>(new Set());

function attachmentKey(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

function isAttachmentExpanded(messageId: string, index: number): boolean {
  return expandedAttachments.value.has(attachmentKey(messageId, index));
}

function toggleAttachment(messageId: string, index: number): void {
  const key = attachmentKey(messageId, index);
  if (expandedAttachments.value.has(key)) expandedAttachments.value.delete(key);
  else expandedAttachments.value.add(key);
}
const isLoading = computed(() => rt.isLoading);

// Live turn status: when the agent works without writing text (a long tool
// call, a slow model), the feed looks frozen — a static "Working…" is
// indistinguishable from a stuck session. Track the turn start and tick a
// 1s clock so the indicator shows WHAT runs and FOR HOW LONG.
const turnStartedAt = ref<number | null>(null);
const turnTick = ref(0);
let turnTimer: ReturnType<typeof setInterval> | null = null;

function stopTurnTimer() {
  if (turnTimer !== null) {
    clearInterval(turnTimer);
    turnTimer = null;
  }
}

watch(isLoading, (loading) => {
  if (loading) {
    turnStartedAt.value = Date.now();
    turnTick.value = 0;
    stopTurnTimer();
    turnTimer = setInterval(() => { turnTick.value += 1; }, 1000);
  } else {
    stopTurnTimer();
    turnStartedAt.value = null;
  }
});

/** Elapsed seconds of the running turn (driven by turnTick). */
const turnElapsedSec = computed(() => {
  if (turnStartedAt.value == null) return 0;
  void turnTick.value;
  return Math.max(0, Math.round((Date.now() - turnStartedAt.value) / 1000));
});

/** Newest in-progress tool call across all messages, if any. */
const activeToolCall = computed(() => {
  let found = null;
  for (const m of messages.value) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.status === 'pending' || tc.status === 'in_progress') found = tc;
    }
  }
  return found;
});

/** One-line live status for the loading indicator. */
const turnStatusText = computed(() => {
  const secs = turnElapsedSec.value;
  const when = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const tc = activeToolCall.value;
  if (tc) return `Working · ${tc.kind} ${tc.title} · ${when}`;
  return `Working · thinking · ${when}`;
});
const isConnected = computed(() => rt.isConnected);
const isReconnecting = computed(() => rt.isReconnecting);
// Non-null while the feed shows the localStorage tail instead of a settled
// transcript: 'loading' during the parallel replay, 'stale' when it died.
const historyCacheNote = computed(() => rt.historyCacheNote);
const currentSession = computed(() => rt.session);
const availableModes = computed(() => rt.availableModes);
const currentModeId = computed(() => rt.currentModeId);
const availableModels = computed(() => rt.availableModels);
const currentModelId = computed(() => rt.currentModelId);

// Context meter ("45k/200k") from the agent's usage_update frames; hidden
// until the agent reports one.
const contextLabel = computed(() => {
  const used = rt.contextUsed;
  if (used == null) return '';
  const f = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
  return rt.contextSize != null ? `${f(used)}/${f(rt.contextSize)}` : f(used);
});
const contextTitle = computed(() => {
  const pct = rt.contextUsed != null && rt.contextSize ? Math.round((rt.contextUsed / rt.contextSize) * 100) : null;
  return pct != null ? `Context: ${pct}% of the window used` : 'Context used';
});
const availableCommands = computed(() => rt.availableCommands);
const isAutonomous = computed(() => rt.autonomous);

// The long desktop placeholder wraps to a second line and clips vertically
// on a phone; CSS can't swap placeholder text, so pick the short form here.
const composerPlaceholder = computed(() => {
  if (!isConnected.value) return 'Offline — cached copy';
  if (isReconnecting.value) return 'Reconnecting…';
  if (isNarrowLayout.value) return 'Message…';
  return availableCommands.value.length > 0
    ? 'Type your message... (/ for commands)'
    : 'Type your message...';
});

// Slash command state
const showCommandPalette = computed(() => {
  if (availableCommands.value.length === 0) return false;
  const text = inputText.value;
  // Show palette when input starts with "/" and cursor is after it
  if (!text.startsWith('/')) return false;
  // Don't show if there's a space (command already entered)
  const spaceIndex = text.indexOf(' ');
  return spaceIndex === -1;
});

const commandFilter = computed(() => {
  if (!inputText.value.startsWith('/')) return '';
  return inputText.value.slice(1); // Remove the leading "/"
});

// FOLLOW INTENT — "the user wants the newest message kept in view".
// Replaces the old is-it-pinned heuristic: that one read the feed's CURRENT
// position, so when `resumeSession` cleared the list (the container clamps
// to scrollTop 0) the first replayed chunk taller than the threshold killed
// the pin for good — the view sat at the top while history streamed in
// below. The intent survives the clear: it is set by actions, never
// re-measured off the feed's position.
const followBottom = ref(true);
const FEED_BOTTOM_PX = 40;
// The scrollTop our own pin just wrote. The scroll handler skips events at
// exactly that position — they are the pin landing, not the user taking the
// wheel. Position matching (not a timed flag) so render-saturated replays
// can't stretch the guard window into a real user scroll.
let programmaticScrollTop: number | null = null;
// The session the follow logic last saw — a clear WITHOUT a switch (a
// same-session resume re-record) must not re-arm the intent: that would
// undo a mid-replay scroll-up the user just made.
let lastSeenSessionId: string | null = null;

watch(useDocumentScroll, (enabled) => {
  if (enabled) {
    const previousTop = messagesContainer.value?.scrollTop ?? 0;
    if (previousTop > 0) savedDocumentTop = previousTop;
    void nextTick(() => {
      const feed = feedScroller();
      if (followBottom.value) pinFeedToBottom();
      else if (feed) feed.scrollTop = savedDocumentTop;
    });
  } else if (sessionStore.activeTabId === rt.id) {
    void nextTick(() => {
      if (followBottom.value) pinFeedToBottom();
      else if (messagesContainer.value) messagesContainer.value.scrollTop = savedDocumentTop;
    });
  }
});

function distanceFromBottom(feed: HTMLElement): number {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight;
}

function pinFeedToBottom(): void {
  const feed = feedScroller();
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
  programmaticScrollTop = feed.scrollTop;
}

// One window-growth step, driven by the near-top scroll trigger only.
// The new rows land ABOVE the viewport: a raw prepend would leave scrollTop
// pointing at newer messages than the one under the cursor, so the offset is
// restored by the height just added (which also keeps a bottom-pinned feed
// pinned: scrollTop lands back on scrollHeight - clientHeight).
function growFeedWindow(): void {
  const feed = feedScroller();
  if (!feed || feed.clientHeight === 0) return;
  const top = feed.scrollTop;
  const height = feed.scrollHeight;
  feedWindow.value = Math.min(feedWindow.value + FEED_WINDOW_STEP, messages.value.length);
  void nextTick(() => {
    // The document scrollport is shared: a tab switch must cancel this write.
    if (feed !== feedScroller()) return;
    feed.scrollTop = top + (feed.scrollHeight - height);
    // A window too short to overflow the feed produces no scroll at all —
    // no event, no trigger, unreachable history. Grow until it can scroll.
    if (feed.clientHeight > 0 && feed.scrollHeight <= feed.clientHeight && hiddenCount.value > 0) {
      growFeedWindow();
    }
  });
}

function onFeedScroll(): void {
  const feed = feedScroller();
  if (!feed) return;
  if (programmaticScrollTop !== null && feed.scrollTop === programmaticScrollTop) {
    // Landed exactly where a pin put it — an at-bottom position is "follow"
    // whoever caused it, but it is not the user scrolling somewhere new.
    followBottom.value = true;
    return;
  }
  programmaticScrollTop = null;
  followBottom.value = distanceFromBottom(feed) <= FEED_BOTTOM_PX;
  // Approaching the hidden-history zone: pull the next chunk into the
  // window. The trigger is ~1.5 viewports from the top (not the edge) so a
  // fast scroll-up never sees empty space. Gated on !followBottom so sitting
  // at the bottom of a barely overflowing feed doesn't grow it unprompted.
  if (
    !followBottom.value &&
    feed.scrollTop < feed.clientHeight * FEED_TOP_VIEWPORTS &&
    hiddenCount.value > 0
  ) {
    growFeedWindow();
  }
}

// The wheel is the one gesture that races the stream: its scroll event
// lands a frame late, so a chunk arriving in between would read a stale
// "at bottom" and yank the feed back under the cursor. Up-wheel means
// "let me read" — flip the flag at the gesture, not at the event.
function onFeedWheel(event: WheelEvent): void {
  if (event.deltaY < 0) followBottom.value = false;
}

// New messages follow the intent — no threshold check on where the feed
// happens to sit. A cleared list is a transcript about to load (every
// open/switch path empties the feed first), so it re-arms the intent there.
// The re-arm only counts when the SESSION actually switched: `resumeSession`
// now records `currentSession` BEFORE clearing (so F5 restores the clicked
// chat even when the load is refused), which fires this watcher a second
// time for the same session — and a mid-replay wheel-up (user intent: "let
// me read") must survive that. Without the id check the re-arm would undo
// the user's scroll-up and the rest of the replay would drag them down.
watch(messages, async (list) => {
  const cleared = list.length === 0;
  const switched = currentSession.value?.sessionId !== lastSeenSessionId;
  if (cleared && switched) {
    followBottom.value = true;
    lastSeenSessionId = currentSession.value?.sessionId ?? null;
    feedWindow.value = FEED_WINDOW_INIT;
  }
  await nextTick();
  if (followBottom.value) pinFeedToBottom();
  // Same dead end as growFeedWindow's tail: hidden rows but a feed that
  // cannot scroll (tail window fits the viewport) means history is
  // unreachable — kick the growth chain started.
  const feed = feedScroller();
  if (feed && feed.clientHeight > 0 && feed.scrollHeight <= feed.clientHeight && hiddenCount.value > 0) {
    growFeedWindow();
  }
}, { deep: true });

// A session opened or switched while the view was mounted: landing on the
// newest is the point of opening a transcript. The window resets with it —
// an expanded view of the previous session must not carry over.
watch(() => currentSession.value?.sessionId, (id, prev) => {
  if (!id || id === prev) return;
  followBottom.value = true;
  feedWindow.value = FEED_WINDOW_INIT;
  void nextTick(pinFeedToBottom);
});

// A background tab mounts hidden (v-show): pin writes to a display:none
// feed are no-ops, so a transcript that streamed in while unfocused would
// open at the top. Re-pin when the tab becomes visible — only while the
// feed is still in follow mode; a user who scrolled up keeps their place.
watch(() => sessionStore.activeTabId === rt.id, (isActive) => {
  if (isActive && followBottom.value) void nextTick(pinFeedToBottom);
});

// Composer autosize: the field rests at one line — the same height as the
// row's icon buttons (34px desktop, 44px touch) — and grows with content up
// to ~8 lines, then scrolls internally. The collapse-and-measure happens in
// one synchronous task so the transcript never sees an intermediate frame;
// a feed pinned to the bottom is re-pinned so a growing composer doesn't
// drag the last message up with it.
const COMPOSER_MAX_PX = 200;

function autosizeComposer() {
  const el = composerEl.value;
  if (!el) return;
  const feed = feedScroller();
  const pinned = !!feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 4;
  const min = parseFloat(getComputedStyle(el).minHeight) || 0;
  el.style.height = 'auto';
  // While dictating, the voice text lives in the overlay, not the field's
  // value — measure it too, or long takes overflow invisibly under it.
  const ov = voiceOverlayEl.value;
  const need =
    ov && voiceActive.value
      ? Math.max(el.scrollHeight, ov.scrollHeight)
      : el.scrollHeight;
  const capped = need > COMPOSER_MAX_PX;
  el.style.height = `${Math.max(min, Math.min(need, COMPOSER_MAX_PX))}px`;
  el.style.overflowY = capped ? 'auto' : 'hidden';
  // Pin the overlay to the bottom so the newest words stay visible.
  if (voiceActive.value && ov) ov.scrollTop = ov.scrollHeight;
  if (pinned && feed) feed.scrollTop = feed.scrollHeight;
}

watch(inputText, async (newVal, oldVal) => {
  // Edits typed while dictating move the insertion mark when they land in
  // front of it, so the voice text stays where the user last saw it.
  if (voicePhase.value !== 'idle') {
    voiceAt.value = moveDictationAnchor(oldVal ?? '', newVal, voiceAt.value);
  }
  await nextTick();
  autosizeComposer();
});

// ---------------- Voice dictation ----------------
//
// VoiceInput owns the mic + the STT socket; this block owns where the
// transcript lands in the field. While a take runs, the textarea's own
// text is transparent and an overlay paints `typed | committed | volatile
// | typed` so settled words read normally and the hypothesis is muted.
type VoicePhase = 'idle' | 'connecting' | 'listening' | 'stopping';

const voicePhase = ref<VoicePhase>('idle');
const voiceElapsed = ref(0);
const voiceAt = ref(0);
const voiceCommitted = ref('');
const voiceVolatile = ref('');
const voiceError = ref<string | null>(null);

const voiceActive = computed(() => voicePhase.value !== 'idle');
const voicePre = computed(() => inputText.value.slice(0, voiceAt.value));
const voicePost = computed(() => inputText.value.slice(voiceAt.value));
// The overlay shows the same separator the final insert will add, so the
// spacing doesn't jump when the take commits.
const voiceText = computed(() => voiceCommitted.value + transcriptSeparator(voiceCommitted.value, voiceVolatile.value) + voiceVolatile.value);
const voiceSep = computed(() => transcriptSeparator(voicePre.value, voiceText.value));
const voiceTailSep = computed(() => transcriptSeparator(voiceCommitted.value, voiceVolatile.value));
const voicePostSep = computed(() => transcriptSeparator(voiceText.value, voicePost.value));

const voiceElapsedText = computed(() => {
  const s = voiceElapsed.value;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

const voiceStatusText = computed(() => {
  switch (voicePhase.value) {
    case 'connecting':
      return 'Starting microphone…';
    case 'listening': {
      return `Listening… ${voiceElapsedText.value}`;
    }
    case 'stopping':
      return 'Finishing…';
    default:
      return voiceError.value;
  }
});

function onVoiceState(s: { phase: VoicePhase; elapsedS: number }) {
  const was = voicePhase.value;
  voicePhase.value = s.phase;
  voiceElapsed.value = s.elapsedS;
  if (s.phase === 'listening' && was !== 'listening') {
    voiceAt.value = composerEl.value?.selectionStart ?? inputText.value.length;
    voiceCommitted.value = '';
    voiceVolatile.value = '';
    voiceError.value = null;
  }
  if (s.phase === 'idle') {
    voiceCommitted.value = '';
    voiceVolatile.value = '';
  }
}

function onVoicePartial(p: SttPartial) {
  voiceCommitted.value = p.committed;
  voiceVolatile.value = p.volatile;
  // The overlay paints a tick later — grow the composer once the text
  // lands so a long take pushes the field down instead of clipping.
  void nextTick(() => autosizeComposer());
}

function onVoiceFinal(text: string) {
  if (text) {
    const inserted = insertDictation(inputText.value, voiceAt.value, text);
    inputText.value = inserted.value;
    const caret = inserted.caret;
    void nextTick(() => {
      composerEl.value?.focus();
      composerEl.value?.setSelectionRange(caret, caret);
    });
  }
}

function onVoiceError(message: string) {
  voiceError.value = message || null;
}

function syncVoiceOverlayScroll() {
  const ta = composerEl.value;
  const ov = voiceOverlayEl.value;
  if (ta && ov) {
    // The overlay holds more than the field (voice text is not in the
    // value), so copying the field's scroll hides the newest words —
    // pin to the bottom instead.
    ov.scrollTop = ov.scrollHeight;
    ov.scrollLeft = ta.scrollLeft;
  }
}

// Width changes (viewport resize, sidebar toggle) rewrap the text — the
// height has to be recomputed. Height-only changes are ignored, which also
// keeps the observer from feeding back into itself.
let composerRo: ResizeObserver | null = null;
let inputRo: ResizeObserver | null = null;
let composerBoxWidth = 0;
onMounted(() => {
  window.addEventListener('scroll', onDocumentScroll, { passive: true });
  window.visualViewport?.addEventListener('resize', onViewportResize);
  // Same MediaQueryList pattern as App.vue's sidebar breakpoint: correct
  // across orientation changes, no resize-throttling.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia('(max-width: 800px)');
    syncNarrowLayout();
    narrowMql.addEventListener('change', syncNarrowLayout);
  }
  // Dismissed update-nag version, persisted in preferences.json.
  void loadUpdateNagDismissal();
  autosizeComposer();
  // Land on the newest messages: mount starts in follow mode and the pin
  // covers both first paint and a replay already streaming in.
  followBottom.value = true;
  void nextTick(pinFeedToBottom);
  // Test seam for the autonomous e2e (same shape as window.__projects):
  // exposes the session + activity stores so the test can flip autonomous
  // mode, shorten the permission timeout through the same code path the
  // production UI uses, and read back the audit entries.
  (window as unknown as { __session: unknown }).__session = sessionStore;
  (window as unknown as { __activity: unknown }).__activity = useActivityStore();
  if (typeof ResizeObserver !== 'undefined' && composerBox.value) {
    composerRo = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w !== composerBoxWidth) {
        composerBoxWidth = w;
        autosizeComposer();
      }
    });
    composerRo.observe(composerBox.value);
  }
  if (typeof ResizeObserver !== 'undefined' && inputContainer.value) {
    inputRo = new ResizeObserver(() => {
      const height = inputContainer.value?.getBoundingClientRect().height ?? 0;
      if (height === inputHeight.value) return;
      inputHeight.value = height;
      if (followBottom.value) void nextTick(pinFeedToBottom);
    });
    inputRo.observe(inputContainer.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onDocumentScroll);
  window.visualViewport?.removeEventListener('resize', onViewportResize);
  stopTurnTimer();
  composerRo?.disconnect();
  composerRo = null;
  inputRo?.disconnect();
  inputRo = null;
  if (narrowMql) {
    narrowMql.removeEventListener('change', syncNarrowLayout);
    narrowMql = null;
  }
});

async function handleSend() {
  if (preparingSend.value) return;
  if (!inputText.value.trim() && attachments.value.length === 0 && !voiceActive.value) return;

  preparingSend.value = true;
  let text: string;
  let files: Attachment[];
  try {
    // Stop requests a final transcript asynchronously. Snapshot only after
    // it has been committed, so a late voice final cannot refill the field.
    if (voiceActive.value) {
      await voiceInputRef.value?.finish();
      // Keep a visibly incomplete dictation for review instead of sending it.
      if (voiceError.value) return;
    }
    text = inputText.value.trim();
    files = attachments.value;
    if (!text && files.length === 0) return;
    followBottom.value = true;
    inputText.value = '';
    attachments.value = [];
    attachError.value = null;
  } finally {
    preparingSend.value = false;
  }
  try {
    // A send while a turn is running is a steer; further drafts stay editable.
    if (isLoading.value) await rt.steer(text, files);
    else await rt.sendPrompt(text, files);
  } catch (e) {
    console.error('Failed to send prompt:', e);
    rt.error = `Send failed: ${e instanceof Error ? e.message : String(e)}`;
    // A turn can fail much later. Restore only an untouched composer;
    // never overwrite the next draft or its attachments. A failure after
    // the user turn reached the transcript keeps the field empty — the
    // text already sits in the feed and restoring it invites a duplicate.
    if (!promptRecorded(e) && !inputText.value && attachments.value.length === 0) {
      attachments.value = files;
      inputText.value = text;
    }
  }
}

function openFilePicker() {
  attachError.value = null;
  fileInput.value?.click();
}

async function stageFiles(picked: File[]) {
  const { attachments: staged, errors } = await readAttachments(picked);
  // The agent advertises image support; attaching one it can't read would just
  // be ignored on its side, so refuse it here with an explanation.
  const unsupportedImages = staged.filter(a => a.kind === 'image' && !supportsImages.value);
  const accepted = staged.filter(a => !unsupportedImages.includes(a));
  attachments.value = [...attachments.value, ...accepted];
  const notes = [
    ...errors,
    ...(unsupportedImages.length
      ? [`${rt.agentName || 'This agent'} does not accept images`]
      : []),
  ];
  attachError.value = notes.length ? notes.join(' · ') : null;
}

async function handleFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  // Reset so picking the same file twice still fires a change event.
  input.value = '';
  if (picked.length === 0) return;
  await stageFiles(picked);
}

// Clipboard screenshots arrive with a generic "image.png" name (or none at
// all); a timestamp keeps the staged chip and the transcript readable. A real
// name — a file copied in the file manager — is left alone.
function namePastedFile(file: File): File {
  if (file.name && file.name !== 'blob' && !/^image\.[a-z0-9]+$/i.test(file.name)) {
    return file;
  }
  const sub = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const d = new Date();
  const stamp = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join('');
  return new File([file], `pasted-${stamp}.${sub === 'jpeg' ? 'jpg' : sub || 'png'}`, {
    type: file.type,
  });
}

// Ctrl+V with a copied image or file stages it as an attachment — same as the
// attach button. A text-only clipboard falls through to the textarea's own
// paste; a mixed one (image + a URL) prefers the file.
function handlePaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  // Same gate as the attach button: no staging mid-turn or while offline.
  if (isLoading.value || isReconnecting.value || !isConnected.value) return;
  event.preventDefault();
  void stageFiles(files.map(namePastedFile));
}

function removeAttachment(id?: string) {
  attachments.value = attachments.value.filter(a => a.id !== id);
  attachError.value = null;
}

function handleKeyDown(event: KeyboardEvent) {
  // Let CommandPalette handle navigation keys when visible
  if (showCommandPalette.value && commandPaletteRef.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      commandPaletteRef.value.handleKeyDown(event);
      return;
    }
  }

  // Escape ends a take before the palette/send handling gets a say.
  if (event.key === 'Escape' && voicePhase.value !== 'idle') {
    event.preventDefault();
    voiceInputRef.value?.stop();
    return;
  }

  // Enter-to-send is desktop only. On mobile we let the textarea insert a
  // newline like every other native chat app and require an explicit tap
  // on the Send button.
  if (submitOnEnter && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function handleCommandSelect(command: SlashCommand) {
  // Replace current input with the command
  if (command.hint) {
    inputText.value = `/${command.name} `;
  } else {
    inputText.value = `/${command.name} `;
  }
}

function handleCommandClose() {
  // Just dismiss, keep the text
}

function handleCancel() {
  rt.cancelOperation();
}

async function handleModeChange(modeId: string) {
  try {
    await rt.setMode(modeId);
  } catch (e) {
    console.error('Failed to change mode:', e);
  }
}

async function handleModelChange(modelId: string) {
  try {
    await rt.setModel(modelId);
  } catch (e) {
    console.error('Failed to change model:', e);
  }
}

function isThoughtExpanded(messageId: string): boolean {
  return expandedThoughts.value.has(messageId);
}

function toggleThought(messageId: string): void {
  if (expandedThoughts.value.has(messageId)) {
    expandedThoughts.value.delete(messageId);
  } else {
    expandedThoughts.value.add(messageId);
  }
}

// Expanded tool-call argument disclosures, keyed by toolCallId (not index)
// so the state survives the windowed render (FEED_WINDOW_*) above.
const expandedToolCalls = ref<Set<string>>(new Set());

function isToolCallExpanded(toolCallId: string): boolean {
  return expandedToolCalls.value.has(toolCallId);
}

function toggleToolCall(toolCallId: string): void {
  if (expandedToolCalls.value.has(toolCallId)) {
    expandedToolCalls.value.delete(toolCallId);
  } else {
    expandedToolCalls.value.add(toolCallId);
  }
}

// Diagram fences emit a `.mermaid-src` placeholder (an escaped <pre>, so a
// source mermaid rejects still shows as an ordinary code block); the
// v-mermaid directive swaps it for rendered SVG once it lands in the DOM.
// A bare fence opening with a diagram keyword counts — agents often skip
// the language tag.
const DIAGRAM_RE =
  /^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4\w+|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|treemap|radar(?:-beta)?)\b/i;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const mdRenderer = new Renderer();
mdRenderer.code = function (this: Renderer, token: Tokens.Code): string {
  const lang = (token.lang ?? '').trim().toLowerCase();
  if (lang === 'mermaid' || lang === 'flowchart' || lang === 'graph' || (!lang && DIAGRAM_RE.test(token.text))) {
    return `<pre class="mermaid-src">${escapeHtml(token.text)}</pre>`;
  }
  return Renderer.prototype.code.call(this, token);
};

const vMermaid: Directive<HTMLElement> = {
  mounted: (el) => hydrateMermaid(el),
  updated: (el) => hydrateMermaid(el),
};

function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false, renderer: mdRenderer }) as string;
}

/** Status glyph for a plan card entry — same quiet register as the chevrons. */
function planGlyph(status: string): string {
  return status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '·';
}
</script>

<template>
  <div class="chat-view" :class="{ 'document-chat-view': isNarrowLayout && !isTauriHost() }" :style="{ '--chat-input-height': `${inputHeight}px` }">
    <div class="chat-column">
      <div class="chat-header">
        <h2>{{ currentSession?.title || 'Chat' }}</h2>
        <div class="header-right">
          <!-- Session creation lives in the sidebar (+) and the welcome
               screen; the header keeps only the session title + agent name. -->
          <span class="agent-name">{{ currentSession?.agentName }}<span v-if="isAutonomous" class="auto-badge">auto</span></span>
        </div>
      </div>
    
    <div
      ref="messagesContainer"
      class="messages-container"
      @scroll="onFeedScroll"
      @wheel.passive="onFeedWheel"
    >
      <div class="messages">
      <!-- Cached-tail marker: the messages below came from localStorage and
           the live replay hasn't confirmed them yet (or never will). -->
      <div v-if="historyCacheNote" class="history-note" :data-state="historyCacheNote">
        {{ historyCacheNote === 'stale'
          ? 'Couldn’t reach the agent — showing the cached copy'
          : 'Loading history…' }}
      </div>
      <!-- Older messages sit outside the render window — scrolling toward
           the top auto-extends it. -->
      <div
        v-for="(message, idx) in renderedMessages"
        :key="message.id"
        :class="[
          'message',
          `message-${message.role}`,
          { streaming: isLoading && windowOffset + idx === messages.length - 1 && message.role === 'assistant' },
        ]"
      >
        <div class="message-head">
          <span class="role">{{
            message.role === 'user' ? 'You' : (currentSession?.agentName || 'Assistant')
          }}</span>
        </div>

        <!-- Attachments on a user/system turn: one bordered block per file,
             stacked on top of the text. Assistant messages render theirs
             inline via segments, where the block actually arrived. -->
        <div
          v-if="message.role !== 'assistant' && message.attachments?.length"
          class="attachment-blocks"
        >
          <MessageAttachment
            v-for="(att, i) in message.attachments"
            :key="att.id || i"
            :att="att"
            :expanded="isAttachmentExpanded(message.id, i)"
            @toggle="toggleAttachment(message.id, i)"
          />
        </div>

        <!-- Collapsed reasoning: a quiet inline disclosure, closed by default. -->
        <div v-if="message.thought && message.role === 'assistant'" class="thought-section">
          <button class="thought-toggle" @click="toggleThought(message.id)">
            <span class="thought-chevron">{{ isThoughtExpanded(message.id) ? '▾' : '▸' }}</span>
            <span class="thought-label">{{ isThoughtExpanded(message.id) ? 'Hide thinking' : 'Thinking' }}</span>
          </button>
          <div v-if="isThoughtExpanded(message.id)" class="thought-content">
            <div v-mermaid v-html="renderMarkdown(message.thought)" />
          </div>
        </div>

        <!-- Assistant parts in arrival order: text split around the tool
             calls that separated it, chips where the calls ran, plan cards
             and file blocks at their own positions. -->
        <div v-if="message.role === 'assistant'" class="message-parts">
          <template v-for="(item, i) in assistantItems(message)" :key="i">
            <div
              v-if="item.kind === 'text'"
              class="message-content"
              :class="{ 'stream-tail': item.last }"
              v-mermaid
              v-html="renderMarkdown(item.text)"
            />
            <ToolCallChip
              v-else-if="item.kind === 'tool'"
              :tc="item.tc"
              :expanded="isToolCallExpanded(item.tc.toolCallId)"
              @toggle="toggleToolCall(item.tc.toolCallId)"
            />
            <MessageAttachment
              v-else-if="item.kind === 'attachment'"
              :att="item.att"
              :expanded="isAttachmentExpanded(message.id, item.index)"
              @toggle="toggleAttachment(message.id, item.index)"
            />
            <div v-else-if="item.kind === 'plan'" class="plan-card">
              <div class="plan-head">Plan</div>
              <ul class="plan-list">
                <li
                  v-for="(entry, pi) in message.plan"
                  :key="pi"
                  :class="['plan-entry', `plan-${entry.status}`]"
                >
                  <span class="plan-status" aria-hidden="true">{{ planGlyph(entry.status) }}</span>
                  <span class="plan-text">{{ entry.content }}</span>
                </li>
              </ul>
            </div>
          </template>
        </div>

        <div
          v-else-if="message.content"
          class="message-content"
          v-mermaid
          v-html="renderMarkdown(message.content)"
        />
      </div>

      </div>
    </div>
    
    <div ref="inputContainer" class="input-container">
      <div class="input-content">
      <!-- Keep live turn progress next to the composer, even
           while the user reads an older part of the transcript. -->
      <div v-if="isLoading" class="loading-indicator">
        <span class="spinner" aria-hidden="true"></span>
        <span class="turn-status-text" :title="turnStatusText">{{ turnStatusText }}</span>
        <span
          v-if="contextLabel && isNarrowLayout"
          class="context-meter"
          :title="contextTitle"
        >{{ contextLabel }}</span>
      </div>
      <!-- Update nag: the agent's own npm update notice from stderr. Desktop
           only; the × persists the offered version, so this exact nag stays
           dismissed while a newer one re-arms the strip. -->
      <div v-if="showUpdateNag && updateNag" class="update-nag" role="status">
        <span class="update-nag-text" :title="updateNag.text">{{ updateNag.text }}</span>
        <button
          class="update-nag-close"
          @click="dismissUpdateNag"
          title="Dismiss"
          aria-label="Dismiss update notice"
        >×</button>
      </div>

      <CommandPalette
        ref="commandPaletteRef"
        :commands="availableCommands"
        :filter="commandFilter"
        :visible="showCommandPalette"
        @select="handleCommandSelect"
        @close="handleCommandClose"
      />

      <!-- Staged files: one dense chip each, with a thumbnail for images. -->
      <div v-if="attachments.length" class="attach-tray">
        <div v-for="att in attachments" :key="att.id" class="attach-chip">
          <img
            v-if="att.kind === 'image' && att.previewUrl"
            :src="att.previewUrl"
            :alt="att.name"
            class="attach-thumb"
          />
          <span v-else class="attach-glyph" aria-hidden="true">▤</span>
          <span class="attach-name" :title="att.name">{{ att.name }}</span>
          <span class="attach-size">{{ formatBytes(att.size) }}</span>
          <button
            class="attach-remove"
            @click="removeAttachment(att.id)"
            title="Remove attachment"
            aria-label="Remove attachment"
          >×</button>
        </div>
      </div>

      <div v-if="attachError" class="attach-error">{{ attachError }}</div>

      <div
        v-if="voicePhase === 'idle' && voiceError"
        class="voice-status is-error"
        role="status"
      >{{ voiceError }}</div>

      <div class="input-row">
        <!-- One framed card, Claude-Code style: the field on top, the bottom
             menu row under it — attach + mic, model and thinking pickers,
             then the context meter and send on the right. -->
        <div ref="composerBox" class="composer-box" @paste="handlePaste">
          <div class="composer-field">
            <textarea
              ref="composerEl"
              v-model="inputText"
              :class="{ 'voice-ghost': voiceActive }"
              :placeholder="composerPlaceholder"
              :disabled="isReconnecting || !isConnected"
              @keydown="handleKeyDown"
              @scroll="syncVoiceOverlayScroll"
              rows="1"
            />
            <!-- While dictating, the field's own text is transparent and
                 this overlay paints it instead: settled words read like
                 typed text, the still-moving hypothesis is muted. -->
            <div
              v-if="voiceActive"
              ref="voiceOverlayEl"
              class="voice-overlay"
              aria-hidden="true"
            ><span>{{ voicePre }}</span><span>{{ voiceSep }}</span><span class="voice-commit">{{ voiceCommitted }}</span><span>{{ voiceTailSep }}</span><span class="voice-volatile">{{ voiceVolatile }}</span><span>{{ voicePostSep }}</span><span>{{ voicePost }}</span></div>
          </div>
          <div class="composer-menu">
            <button
              class="icon-btn attach-btn"
              :class="{ active: attachments.length > 0 }"
              :disabled="isLoading || isReconnecting || !isConnected"
              @click="openFilePicker"
              :title="imageHint"
              aria-label="Attach files"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 01-7.78-7.78l8.49-8.49a3.5 3.5 0 014.95 4.95l-8.49 8.49a1.5 1.5 0 01-2.12-2.12l7.78-7.78" />
              </svg>
            </button>
            <input
              ref="fileInput"
              class="file-input"
              type="file"
              multiple
              accept="image/*,.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.log,.yaml,.yml,.xml,.html,.css,.js,.mjs,.ts,.tsx,.vue,.py,.sh,.sql,.toml,.ini,.cfg,.conf,.diff,.patch"
              @change="handleFilesPicked"
            />
            <VoiceInput
              ref="voiceInputRef"
              :disabled="isReconnecting || !isConnected"
              @state="onVoiceState"
              @partial="onVoicePartial"
              @final="onVoiceFinal"
              @error="onVoiceError"
            />
            <UiComposerSettings>
              <ModelPicker
                v-if="availableModels.length > 0"
                :models="availableModels"
                :current-model-id="currentModelId"
                :disabled="isReconnecting || !isConnected"
                compact
                @change="handleModelChange"
              />
              <ModePicker
                v-if="availableModes.length > 0"
                :modes="availableModes"
                :current-mode-id="currentModeId"
                :disabled="isReconnecting || !isConnected"
                compact
                @change="handleModeChange"
              />
              <UiFullscreen />
              <ModePicker
                :modes="RUN_MODES"
                :current-mode-id="wfStore.chatMode"
                compact
                @change="(id) => wfStore.setChatMode(id as 'chat' | 'workflow')"
              />
            </UiComposerSettings>
            <span
              v-if="voiceActive"
              class="voice-status voice-status-inline"
              role="status"
              :title="voiceStatusText || undefined"
            ><span v-if="voicePhase === 'listening'" class="voice-recording-label">Listening… </span><span>{{ voicePhase === 'listening' ? voiceElapsedText : voiceStatusText }}</span></span>
            <span v-else class="composer-spacer" aria-hidden="true"></span>
            <span
              v-if="contextLabel && (!isNarrowLayout || !isLoading)"
              class="context-meter"
              :title="contextTitle"
            >{{ contextLabel }}</span>
            <UiButton
              v-if="isLoading"
              class="stop-btn"
              icon
              aria-label="Stop"
              title="Stop response"
              @click="handleCancel"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            </UiButton>
            <button
              class="icon-btn send-btn"
              :disabled="preparingSend || (!inputText.trim() && attachments.length === 0 && !voiceCommitted && !voiceVolatile) || isReconnecting || !isConnected"
              @click="handleSend"
              title="Send"
              aria-label="Send"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4 20-7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      </div><!-- input-content -->
    </div>
    </div><!-- chat-column -->

    <!-- Workflow run mode: the porch stepper docked right of the feed. -->
    <WorkflowPanel v-if="wfStore.chatMode === 'workflow'" class="workflow-side" />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: row;
  /* Flex sibling of the tab strip in .main-content: take the remaining
   * height and allow shrinking below min-content — height:100% here made
   * the composer overflow past the viewport by exactly the tab strip's
   * height whenever 2+ tabs were open. */
  flex: 1;
  min-height: 0;
}

/* The chat feed itself (header + messages + composer) stays a column; the
 * workflow side panel is a row sibling docked right of it. */
.chat-column {
  --chat-content-width: 780px;
  --chat-content-gutter: 1.5rem;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* Workflow run-mode side panel: fixed-width stepper column, border shared
 * with the app's pane style. */
.workflow-side {
  width: 380px;
  flex: 0 0 380px;
  border-left: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  background: var(--bg-main, #fbf8f3);
}

.chat-header {
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.chat-header h2 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.agent-name {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  letter-spacing: 0.02em;
  color: var(--text-muted, #a39a8e);
}

/* Autonomous run marker: one mono token, same palette as the header. */
.auto-badge {
  display: inline-block;
  margin-left: 0.375rem;
  padding: 0.0625rem 0.3rem;
  border-radius: var(--radius-sm, 4px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem var(--chat-content-gutter) 0.75rem;
}

/* Reading column: capped measure so long agent answers stay scannable. */
.messages {
  max-width: var(--chat-content-width);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.message {
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
}

/* User turns are input, not output: a compact sand card, pushed right. */
.message-user {
  align-self: flex-end;
  max-width: 88%;
  margin-left: 12%;
  padding: 0.5rem 0.75rem;
  background: var(--bg-user, #f3e3d3);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-lg, 10px);
}

/* Assistant turns carry no chrome at all — the text is the interface. */
.message-assistant {
  padding: 0;
}

/* Cached-tail marker: quiet, centered, reads as provenance not chrome. */
.history-note {
  align-self: center;
  padding: 0.1875rem 0.625rem;
  border-radius: var(--radius-lg, 10px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  color: var(--text-muted, #a39a8e);
}

.history-note[data-state='stale'] {
  color: var(--text-secondary, #6b6259);
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.message-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.role {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.message-user .role {
  color: var(--text-secondary, #6b6259);
}

/* Streaming caret: shows the turn is still running, no spinner needed. */
@keyframes caret-blink {
  50% { opacity: 0; }
}

/* The caret belongs on the LAST part only — a text segment still streaming.
 *  When a tool chip or a plan card is the tail, the turn status line below
 *  the feed already carries the "working" signal. */
.message.streaming .message-content.stream-tail::after {
  content: '▍';
  margin-left: 2px;
  color: var(--text-accent, #c2532f);
  animation: caret-blink 1.1s steps(1) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .message.streaming .message-content.stream-tail::after {
    animation: none;
  }
}

/* Assistant parts stack: uniform rhythm between text blocks, chips, plan
 *  cards and file blocks — parts arrive ordered, never glued. */
.message-parts {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

/* The agent's published plan: a quiet card in the same register as thought. */
.plan-card {
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
}

.plan-head {
  margin-bottom: 0.25rem;
  font-family: var(--font-mono, monospace);
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.plan-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-entry {
  display: flex;
  gap: 0.4375rem;
  align-items: baseline;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--text-secondary, #6b6259);
}

.plan-entry.plan-completed .plan-text {
  color: var(--text-muted, #a39a8e);
  text-decoration: line-through;
}

.plan-entry.plan-in_progress .plan-text {
  color: var(--text-primary, #2b2723);
}

.plan-status {
  flex: 0 0 auto;
  width: 0.75rem;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.plan-entry.plan-in_progress .plan-status { color: #3b82f6; }
.plan-entry.plan-completed .plan-status { color: #4f8a52; }

.message-content {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--text-primary, #2b2723);
  overflow-wrap: anywhere;
}

.message-content :deep(p) {
  margin: 0 0 0.5rem;
}

.message-content :deep(p:last-child) {
  margin-bottom: 0;
}

.message-content :deep(h1),
.message-content :deep(h2),
.message-content :deep(h3) {
  margin: 0.75rem 0 0.375rem;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.message-content :deep(ol),
.message-content :deep(ul) {
  margin: 0.375rem 0;
  padding-left: 1.125rem;
}

.message-content :deep(li) {
  margin: 0.125rem 0;
}

.message-content :deep(a) {
  color: var(--text-accent, #c2532f);
  text-decoration: none;
  border-bottom: 1px solid var(--accent-soft, rgba(194, 83, 47, 0.25));
}

.message-content :deep(blockquote) {
  margin: 0.5rem 0;
  padding-left: 0.75rem;
  border-left: 2px solid var(--border-color, #e3dbcf);
  color: var(--text-secondary, #6b6259);
}

.message-content :deep(pre) {
  margin: 0.5rem 0;
  background: var(--bg-code, #2b2723);
  color: var(--text-code, #e8e0d5);
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-md, 6px);
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-x: auto;
}

.message-content :deep(code) {
  font-family: var(--font-mono, monospace);
  font-size: 0.85em;
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  padding: 0.0625rem 0.25rem;
  border-radius: 3px;
  /* Code chips are tokens: never split mid-token (`131k/1.0М` used to
   * break between glyphs on a narrow screen). They still wrap at spaces;
   * prose keeps `overflow-wrap: anywhere` from .message-content. */
  overflow-wrap: normal;
  word-break: normal;
}

/* Markdown tables on a narrow screen: the table scrolls horizontally inside
 * the message instead of crushing its columns into mid-word wraps. Cells
 * drop the prose-wide `overflow-wrap: anywhere` and wrap whole words. */
.message-content :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 0.75rem 0;
}

.message-content :deep(td),
.message-content :deep(th) {
  border: 1px solid var(--border-strong);
  padding: 0.5rem 0.75rem;
  vertical-align: top;
  overflow-wrap: normal;
  word-break: normal;
}

.message-content :deep(th) {
  background: var(--bg-hover);
}

.message-content :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

/* Mermaid diagrams hydrate asynchronously from `.mermaid-src` code blocks
 * (lib/mermaid.ts); until then they render exactly like a code fence. An
 * oversized diagram scrolls inside the message instead of widening it. */
.message-content :deep(.mermaid),
.thought-content :deep(.mermaid) {
  margin: 0.5rem 0;
  overflow-x: auto;
}

.message-content :deep(.mermaid svg),
.thought-content :deep(.mermaid svg) {
  display: block;
  max-width: 100%;
  height: auto;
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem 0.5rem;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  color: var(--text-muted, #a39a8e);
}

.spinner {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  border: 2px solid var(--border-color, #ccc);
  border-top-color: var(--text-accent, #c2532f);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.stop-btn {
  flex-shrink: 0;
}

.turn-status-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.input-container {
  padding: 0.625rem var(--chat-content-gutter);
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

/* Match the reading column, including notices and staged attachments. */
.input-content {
  position: relative;
  width: 100%;
  max-width: var(--chat-content-width);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

/* One framed card: the field on top, the bottom menu row beneath it —
 * attach + mic on the left, model/thinking pickers next, context meter and
 * send on the right. */
.composer-box {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-lg, 10px);
  background: var(--bg-main, #fbf8f3);
  transition: border-color 0.15s;
}

.composer-menu {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  flex-wrap: wrap;
}

.composer-spacer {
  flex: 1;
}

.context-meter {
  flex: 0 0 auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.7rem;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  padding: 0 0.375rem;
}

.composer-box:focus-within {
  border-color: var(--text-accent, #b04a28);
}

/* One geometry for every composer button: a square stroke-icon hit area.
 * No fills except the primary action, no shadows anywhere. */
.icon-btn {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  box-shadow: none;
  cursor: pointer;
}

.icon-btn svg {
  display: block;
}

.icon-btn:focus-visible {
  outline: 2px solid var(--text-accent, #b04a28);
  outline-offset: 2px;
}

.icon-btn:disabled {
  cursor: not-allowed;
}

/* ---------------- Attachments ---------------- */

/* Attach lives inside the field's frame, so it carries no border of its
 * own — a quiet glyph that tints on hover and marks staged files. */
.attach-btn:hover:not(:disabled) {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.attach-btn.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  color: var(--text-accent, #b04a28);
}

.attach-btn:disabled {
  color: var(--text-muted, #786d62);
}

.file-input {
  display: none;
}

.attach-tray {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.attach-chip {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 100%;
  height: 26px;
  padding: 0 0.25rem 0 0.375rem;
  border-radius: var(--radius-md, 6px);
  background: var(--bg-hover, #efe9e0);
  font-size: 0.75rem;
}

.attach-thumb {
  width: 18px;
  height: 18px;
  object-fit: cover;
  border-radius: 3px;
}

.attach-glyph {
  font-size: 0.75rem;
  color: var(--text-muted, #a39a8e);
}

.attach-name {
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-primary, #2b2723);
}

.attach-size,
.message-attach-size {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.attach-remove {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-muted, #a39a8e);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.attach-remove:hover {
  background: var(--bg-danger-hover, #9c3524);
  color: var(--text-on-accent, #fbf8f3);
}

.attach-error {
  padding: 0 0.125rem;
  font-size: 0.6875rem;
  color: var(--bg-danger, #b3402e);
}

/* Update nag: one quiet warning-tinted strip above the composer. The long
 * npm command ellipsizes — the full line is on the title tooltip. */
.update-nag {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.375rem 0.25rem 0.625rem;
  border-radius: var(--radius-md, 6px);
  background: var(--bg-warning, #f5e9cf);
}

.update-nag-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-primary, #2b2723);
}

.update-nag-close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.update-nag-close:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

/* Sent attachments in the transcript: one bordered block per file, stacked,
 * sitting on the message like an artefact rather than running as prose.
 * The block itself lives in MessageAttachment.vue. */
.attachment-blocks {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin: 0.25rem 0 0.5rem;
}

/* Borderless inside the shared frame; the box carries the hairline and the
 * focus color. Rest height is exactly one line — 20px line + 14px padding
 * = 34px, level with the icon buttons — and JS grows it to COMPOSER_MAX_PX. */
.composer-box textarea {
  flex: 1;
  min-width: 0;
  min-height: 34px;
  height: 34px;
  padding: 7px 0.125rem;
  border: none;
  background: transparent;
  font-size: 0.875rem;
  font-family: inherit;
  line-height: 20px;
  color: var(--text-primary, #2b2723);
  resize: none;
  overflow-y: hidden;
}

.composer-box textarea:focus {
  outline: none;
}

.composer-box textarea::placeholder {
  color: var(--text-muted, #786d62);
  opacity: 1;
}

.composer-box textarea:disabled {
  color: var(--text-muted, #786d62);
}

/* Wrapper keeps the dictation overlay pinned exactly over the textarea. */
.composer-field {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
}

/* While a take runs the textarea's own glyphs go transparent (caret stays
 * via caret-color) and the overlay paints the same box: typed text and
 * committed words in the field's normal colour, the volatile hypothesis in
 * muted. Metrics mirror the textarea's so the two layers sit pixel-aligned. */
.composer-box textarea.voice-ghost {
  color: transparent;
  caret-color: var(--text-primary, #2b2723);
}

/* An empty field still matches :placeholder-shown while dictating (the
 * voice text lives in the overlay, not the value), so the hint would print
 * under the first dictated words — hide it for the take. */
.composer-box textarea.voice-ghost::placeholder {
  color: transparent;
}

.voice-overlay {
  position: absolute;
  inset: 0;
  padding: 7px 0.125rem;
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 20px;
  color: var(--text-primary, #2b2723);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  overflow: hidden;
  pointer-events: none;
}

.voice-overlay .voice-volatile {
  color: var(--text-muted, #786d62);
}

/* Recording status shares the toolbar; failures keep a full-width line
 * so their reason stays readable on narrow screens. */
.voice-status {
  padding: 0 0.125rem;
  font-size: 0.6875rem;
  color: var(--text-muted, #786d62);
}

.voice-status-inline {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.voice-status.is-error {
  color: var(--bg-danger, #b3402e);
}

/* --bg-danger reads ~5.4:1 on paper but only ~2.7:1 on the dark surface —
 * the accent token keeps the failure legible there (>= 4.5:1). */
@media (prefers-color-scheme: dark) {
  .voice-status.is-error {
    color: var(--text-accent, #f0a184);
  }
}

/* The only filled element in the row: accent when armed, a quiet hairline
 * when there is nothing to send — not a faded fill. */
.send-btn {
  background: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fbf8f3);
  /* No colour transition: arming the button changes fill + ink, and any
   * mid-flight frame reads sub-contrast (measured 2.18–3.32:1 at ~80 ms
   * into a 150 ms fade). The state snaps like every other flat control. */
}

.send-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover, #a8431f);
}

.send-btn:disabled {
  background: transparent;
  border-color: var(--border-faint, rgba(43, 39, 35, 0.09));
  color: var(--text-muted, #786d62);
}

/* ---------- Mobile / narrow-viewport tweaks ---------- */

@media (max-width: 800px) {
  .chat-column {
    --chat-content-gutter: 0.75rem;
  }

  /* Narrow screens: the stepper column would eat the feed — hide it; the
   * composer switch still works, the panel just isn't shown here. */
  .workflow-side {
    display: none;
  }

  /* Identity/title live in the drawer on phones. Keep only the OS safe
     area here, without an empty header row above the transcript. */
  .chat-header {
    min-height: 0;
    padding: env(safe-area-inset-top, 0px) 0 0;
    border-bottom: 0;
  }

  /* The hidden identity row has no intrinsic height on phones. */
  .header-right {
    display: flex;
    flex-wrap: wrap;
    min-width: 0;
  }

  /* Agent identity and the session title are available in the drawer. */
  .agent-name {
    display: none;
  }


  .chat-header h2 {
    display: none;
  }

  .input-container {
    /* Edge-to-edge on phones; the shell reserves the home-indicator inset. */
    padding: 0;
    border-top: 0;
  }

  .input-content {
    max-width: none;
    gap: 0.5rem;
  }

  .composer-box textarea {
    /* Avoid iOS auto-zoom on focus when font-size < 16px. Rest height
     * stays level with the 44px touch buttons: 22px line + 22px padding. */
    font-size: 16px;
    line-height: 22px;
    padding-top: 11px;
    padding-bottom: 11px;
    min-height: 44px;
  }

  .voice-recording-label {
    display: none;
  }

  .voice-overlay {
    font-size: 16px;
    line-height: 22px;
    padding-top: 11px;
    padding-bottom: 11px;
  }

  /* Touch targets: same square geometry, bumped to 44px. The composer
     row stays one line — the field flexes, buttons never shrink or
     wrap, and nothing may overflow the 390px viewport. */
  .input-row {
    flex-wrap: nowrap;
  }

  .composer-menu {
    flex-wrap: nowrap;
  }

  .composer-box {
    flex: 1 1 auto;
    min-width: 0;
    border-radius: 0;
    border-width: 1px 0 0;
  }

  .icon-btn {
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
  }

  .voice-btn {
    flex: 0 0 auto;
  }

  /* The edge is part of the native feed scroller: a vertical swipe here
     scrolls history; a horizontal one reaches the shell drawer handler. */
  .messages-container::before {
    content: '';
    position: fixed;
    inset: var(--mobile-navigation-height, 0px) auto 0 0;
    width: 24px;
    z-index: 80;
    touch-action: pan-y pinch-zoom;
  }

  /* Native document scrolling lets the browser collapse its own chrome.
     Fixed navigation/composer leave the history as the page's content. */
  .document-chat-view {
    min-height: var(--app-viewport-height, 100dvh);
  }
  .document-chat-view .messages-container {
    overflow: visible;
    padding-top: calc(0.875rem + var(--mobile-navigation-height, 0px) + env(safe-area-inset-top, 0px));
    padding-bottom: calc(0.5rem + var(--chat-input-height, 0px) + max(0px, 100dvh - var(--app-viewport-height, 100dvh) - var(--app-viewport-top, 0px)));
  }
  .document-chat-view .input-container {
    position: fixed;
    top: calc(var(--app-viewport-top, 0px) + var(--app-viewport-height, 100dvh) - var(--chat-input-height, 0px));
    left: 0;
    right: 0;
    z-index: 3;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: var(--bg-main);
  }

  /* Narrow screens: give the reading column the full width back. */
  .messages-container {
    touch-action: pan-y pinch-zoom;
    padding: 0.875rem var(--chat-content-gutter) 0.5rem;
  }

  .message-user {
    max-width: 94%;
    margin-left: 6%;
  }

  .tool-name {
    max-width: 38%;
  }
}

/* Agent thinking: a quiet inline disclosure, not a boxed panel. */
.thought-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.thought-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.75rem;
  color: var(--text-muted, #a39a8e);
}

.thought-toggle:hover {
  color: var(--text-secondary, #6b6259);
}

.thought-label {
  font-weight: 500;
}

.thought-chevron {
  font-size: 0.625rem;
}

.thought-content {
  max-height: 320px;
  overflow-y: auto;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-md, 6px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  font-size: 0.8125rem;
  line-height: 1.55;
  color: var(--text-secondary, #6b6259);
}

.thought-content :deep(p) {
  margin: 0 0 0.5rem 0;
}

.thought-content :deep(p:last-child) {
  margin-bottom: 0;
}

.thought-content :deep(code) {
  background: var(--bg-hover, #f0f0f0);
  padding: 0.125rem 0.25rem;
  border-radius: 3px;
  font-size: 0.85em;
}
</style>
