<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { marked } from 'marked';
import { useSessionStore } from '../stores/session';
import { useActivityStore } from '../stores/activity';
import { isMobile } from '../lib/platform';
import { readAttachments, formatBytes, extractReplayedAttachments, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from '../lib/attachments';
import ModePicker from './ModePicker.vue';
import ModelPicker from './ModelPicker.vue';
import CommandPalette from './CommandPalette.vue';
import VoiceInput from './VoiceInput.vue';
import NewSessionDialog from '../features/projects/NewSessionDialog.vue';
import type { Attachment, AttachmentMeta, SlashCommand } from '../lib/types';
import type { SttPartial } from '../lib/stt';

const sessionStore = useSessionStore();
const inputText = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const commandPaletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);

// Header "New session": unlike the sidebar button (hidden while
// connected), this one stays put for as long as the chat view is mounted.
const showNewSession = ref(false);

// Files staged for the next turn, and the last attach error (limits, wrong type).
const attachments = ref<Attachment[]>([]);
const attachError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const composerEl = ref<HTMLTextAreaElement | null>(null);
const composerBox = ref<HTMLElement | null>(null);
const voiceInputRef = ref<InstanceType<typeof VoiceInput> | null>(null);
const voiceOverlayEl = ref<HTMLElement | null>(null);
const supportsImages = computed(() => sessionStore.supportsImages);
const imageHint = computed(
  () => `Images and text files (max ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)} / ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)})`
);

// On mobile (iOS/Android) the soft-keyboard's Return key should insert a
// newline like every other native chat app; submitting is the dedicated
// Send button. On desktop, Enter still submits and Shift+Enter newlines.
const submitOnEnter = !isMobile();

// Track expanded thought sections by message id
const expandedThoughts = ref<Set<string>>(new Set());

const messages = computed(() => sessionStore.messageList);

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
 */
const renderedMessages = computed(() =>
  messages.value.map((message) => {
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
const isLoading = computed(() => sessionStore.isLoading);
const isConnected = computed(() => sessionStore.isConnected);
const isReconnecting = computed(() => sessionStore.isReconnecting);
// Non-null while the feed shows the localStorage tail instead of a settled
// transcript: 'loading' during the parallel replay, 'stale' when it died.
const historyCacheNote = computed(() => sessionStore.historyCacheNote);
const currentSession = computed(() => sessionStore.currentSession);
const availableModes = computed(() => sessionStore.availableModes);
const currentModeId = computed(() => sessionStore.currentModeId);
const availableModels = computed(() => sessionStore.availableModels);
const currentModelId = computed(() => sessionStore.currentModelId);
const availableCommands = computed(() => sessionStore.availableCommands);
const isAutonomous = computed(() => sessionStore.autonomous);

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

function distanceFromBottom(feed: HTMLElement): number {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight;
}

function pinFeedToBottom(): void {
  const feed = messagesContainer.value;
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
  programmaticScrollTop = feed.scrollTop;
}

function onFeedScroll(): void {
  const feed = messagesContainer.value;
  if (!feed) return;
  if (programmaticScrollTop !== null && feed.scrollTop === programmaticScrollTop) {
    // Landed exactly where a pin put it — an at-bottom position is "follow"
    // whoever caused it, but it is not the user scrolling somewhere new.
    followBottom.value = true;
    return;
  }
  programmaticScrollTop = null;
  followBottom.value = distanceFromBottom(feed) <= FEED_BOTTOM_PX;
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
  }
  await nextTick();
  if (followBottom.value) pinFeedToBottom();
}, { deep: true });

// A session opened or switched while the view was mounted: landing on the
// newest is the point of opening a transcript.
watch(() => currentSession.value?.sessionId, (id, prev) => {
  if (!id || id === prev) return;
  followBottom.value = true;
  void nextTick(pinFeedToBottom);
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
  const feed = messagesContainer.value;
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
    const delta = newVal.length - (oldVal?.length ?? 0);
    const caret = composerEl.value?.selectionStart ?? newVal.length;
    if (delta !== 0 && caret <= voiceAt.value) {
      voiceAt.value = Math.max(0, Math.min(voiceAt.value + delta, newVal.length));
    }
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
const voiceSep = computed(() =>
  (voiceCommitted.value || voiceVolatile.value) &&
  voicePre.value.length > 0 &&
  !/\s$/.test(voicePre.value)
    ? ' '
    : '',
);

const voiceStatusText = computed(() => {
  switch (voicePhase.value) {
    case 'connecting':
      return 'Starting microphone…';
    case 'listening': {
      const s = voiceElapsed.value;
      return `Listening… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
    const pre = inputText.value.slice(0, voiceAt.value);
    const post = inputText.value.slice(voiceAt.value);
    const insert = (pre.length > 0 && !/\s$/.test(pre) ? ' ' : '') + text;
    inputText.value = pre + insert + post;
    const caret = pre.length + insert.length;
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
let composerBoxWidth = 0;
onMounted(() => {
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
});
onBeforeUnmount(() => {
  composerRo?.disconnect();
  composerRo = null;
});

async function handleSend() {
  const text = inputText.value.trim();
  if ((!text && attachments.value.length === 0) || isLoading.value) return;

  // A take in flight would land its final text into the cleared field —
  // stop it first so the send and the dictation don't interleave.
  voiceInputRef.value?.stop();

  // Sending is an explicit "show me the newest" — re-arm the follow even
  // while the user has the feed scrolled up.
  followBottom.value = true;

  const files = attachments.value;
  inputText.value = '';
  attachments.value = [];
  attachError.value = null;
  try {
    await sessionStore.sendPrompt(text, files);
  } catch (e) {
    // A rejected prompt used to die in the console: the composer cleared, the
    // turn produced nothing, and the user saw no reason. Surface it.
    console.error('Failed to send prompt:', e);
    sessionStore.error = `Send failed: ${e instanceof Error ? e.message : String(e)}`;
    // Hand the files back so the turn can be retried without re-picking them.
    attachments.value = files;
    inputText.value = text;
  }
}

function openFilePicker() {
  attachError.value = null;
  fileInput.value?.click();
}

async function handleFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  // Reset so picking the same file twice still fires a change event.
  input.value = '';
  if (picked.length === 0) return;

  const { attachments: staged, errors } = await readAttachments(picked);
  // The agent advertises image support; attaching one it can't read would just
  // be ignored on its side, so refuse it here with an explanation.
  const unsupportedImages = staged.filter(a => a.kind === 'image' && !supportsImages.value);
  const accepted = staged.filter(a => !unsupportedImages.includes(a));
  attachments.value = [...attachments.value, ...accepted];
  const notes = [
    ...errors,
    ...(unsupportedImages.length
      ? [`${sessionStore.lastAgentName || 'This agent'} does not accept images`]
      : []),
  ];
  attachError.value = notes.length ? notes.join(' · ') : null;
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
  sessionStore.cancelOperation();
}

async function handleModeChange(modeId: string) {
  try {
    await sessionStore.setMode(modeId);
  } catch (e) {
    console.error('Failed to change mode:', e);
  }
}

async function handleModelChange(modelId: string) {
  try {
    await sessionStore.setModel(modelId);
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

function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}

/** Short kind label for a tool chip (uppercased by CSS, set in mono). */
function getToolKind(kind: string): string {
  switch (kind) {
    case 'read': return 'read';
    case 'edit': return 'edit';
    case 'delete': return 'del';
    case 'move': return 'move';
    case 'search': return 'find';
    case 'execute': return 'run';
    case 'think': return 'think';
    case 'fetch': return 'fetch';
    default: return 'tool';
  }
}
</script>

<template>
  <div class="chat-view">
    <div class="chat-header">
      <h2>{{ currentSession?.title || 'Chat' }}</h2>
      <div class="header-right">
        <button
          class="chat-new-session"
          type="button"
          :disabled="isLoading || isReconnecting"
          @click="showNewSession = true"
        >
          New session
        </button>
        <ModelPicker 
          v-if="availableModels.length > 0"
          :models="availableModels"
          :current-model-id="currentModelId"
          :disabled="isLoading"
          @change="handleModelChange"
        />
        <ModePicker 
          v-if="availableModes.length > 0"
          :modes="availableModes"
          :current-mode-id="currentModeId"
          :disabled="isLoading"
          @change="handleModeChange"
        />
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
      <div
        v-for="(message, idx) in renderedMessages"
        :key="message.id"
        :class="[
          'message',
          `message-${message.role}`,
          { streaming: isLoading && idx === renderedMessages.length - 1 && message.role === 'assistant' },
        ]"
      >
        <div class="message-head">
          <span class="role">{{
            message.role === 'user' ? 'You' : (currentSession?.agentName || 'Assistant')
          }}</span>
        </div>

        <!-- Attachments: one bordered block per file, attached to the message
             rather than buried in its text. -->
        <div v-if="message.attachments?.length" class="attachment-blocks">
          <div
            v-for="(att, i) in message.attachments"
            :key="att.id || i"
            class="attachment-block"
          >
            <img
              v-if="att.kind === 'image' && att.previewUrl"
              :src="att.previewUrl"
              :alt="att.name"
              class="attachment-image"
            />
            <div class="attachment-line">
              <span class="attachment-kind">{{ att.kind }}</span>
              <span class="attachment-name" :title="att.name">{{ att.name }}</span>
              <span v-if="att.size" class="attachment-size">{{ formatBytes(att.size) }}</span>
              <button
                v-if="att.body"
                class="attachment-toggle"
                @click="toggleAttachment(message.id, i)"
              >
                {{ isAttachmentExpanded(message.id, i) ? 'Hide file' : 'Show file' }}
              </button>
              <!-- An image/file whose bytes could not be recovered is a named
                   placeholder with a reason — never a silent gap. -->
              <span
                v-else-if="att.unavailableReason"
                class="attachment-note attachment-missing"
              >{{ att.unavailableReason }}</span>
              <span v-else-if="att.kind === 'image' && !att.previewUrl" class="attachment-note">no preview in history</span>
            </div>
            <pre
              v-if="att.body && isAttachmentExpanded(message.id, i)"
              class="attachment-body"
            >{{ att.body }}</pre>
          </div>
        </div>

        <!-- Collapsed reasoning: a quiet inline disclosure, closed by default. -->
        <div v-if="message.thought && message.role === 'assistant'" class="thought-section">
          <button class="thought-toggle" @click="toggleThought(message.id)">
            <span class="thought-chevron">{{ isThoughtExpanded(message.id) ? '▾' : '▸' }}</span>
            <span class="thought-label">{{ isThoughtExpanded(message.id) ? 'Hide thinking' : 'Thinking' }}</span>
          </button>
          <div v-if="isThoughtExpanded(message.id)" class="thought-content">
            <div v-html="renderMarkdown(message.thought)" />
          </div>
        </div>

        <!-- Tool calls: one dense chip per call, status carried by a dot. -->
        <div v-if="message.toolCalls?.length" class="tool-calls-section">
          <div
            v-for="tc in message.toolCalls"
            :key="tc.toolCallId"
            :class="['tool-call-inline', `tool-${tc.status}`]"
          >
            <span class="tool-dot" aria-hidden="true"></span>
            <span class="tool-kind">{{ getToolKind(tc.kind) }}</span>
            <span class="tool-name">{{ tc.title }}</span>
            <span v-if="tc.locations?.length" class="tool-location">
              {{ tc.locations[0].path }}
            </span>
          </div>
        </div>

        <div
          v-if="message.content"
          class="message-content"
          v-html="renderMarkdown(message.content)"
        />
      </div>

      <!-- Loading indicator -->
      <div v-if="isLoading" class="loading-indicator">
        <span class="spinner"></span>
        <span>Working…</span>
        <button class="cancel-btn" @click="handleCancel">Stop</button>
      </div>
      </div>
    </div>
    
    <div class="input-container">
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
        v-if="voiceStatusText"
        class="voice-status"
        :class="{ 'is-error': voicePhase === 'idle' && voiceError }"
        role="status"
      >{{ voiceStatusText }}</div>

      <div class="input-row">
        <!-- Field + attach read as one control: the hairline frame is the
             box, the ghost attach button sits inside it on the last line. -->
        <div ref="composerBox" class="composer-box">
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
          <div class="composer-field">
            <textarea
              ref="composerEl"
              v-model="inputText"
              :class="{ 'voice-ghost': voiceActive }"
              :placeholder="
                !isConnected
                  ? 'Offline — cached copy'
                  : isReconnecting
                    ? 'Reconnecting…'
                    : (availableCommands.length > 0
                        ? 'Type your message... (/ for commands)'
                        : 'Type your message...')
              "
              :disabled="isLoading || isReconnecting || !isConnected"
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
            ><span>{{ voicePre }}</span><span>{{ voiceSep }}</span><span class="voice-commit">{{ voiceCommitted }}</span><span class="voice-volatile">{{ voiceVolatile }}</span><span>{{ voicePost }}</span></div>
          </div>
        </div>
        <VoiceInput
          ref="voiceInputRef"
          :disabled="isLoading || isReconnecting || !isConnected"
          @state="onVoiceState"
          @partial="onVoicePartial"
          @final="onVoiceFinal"
          @error="onVoiceError"
        />
        <button
          class="icon-btn send-btn"
          :disabled="(!inputText.trim() && attachments.length === 0) || isLoading || isReconnecting || !isConnected"
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
      </div>    </div>

    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
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

.chat-new-session {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 0.75rem;
  border: 1px solid var(--bg-primary, #c2532f);
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-accent, #c2532f);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.chat-new-session:hover:not(:disabled) {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
}

.chat-new-session:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  padding: 1.25rem 1.5rem 0.75rem;
}

/* Reading column: capped measure so long agent answers stay scannable. */
.messages {
  max-width: 780px;
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

.message.streaming .message-content::after {
  content: '▍';
  margin-left: 2px;
  color: var(--text-accent, #c2532f);
  animation: caret-blink 1.1s steps(1) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .message.streaming .message-content::after {
    animation: none;
  }
}

/* Tool calls inline styles */
.tool-calls-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-call-inline {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-height: 24px;
  padding: 0 0.5rem;
  border-radius: var(--radius-sm, 4px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
}

.tool-in_progress {
  background: rgba(59, 130, 246, 0.07);
}

.tool-failed {
  background: rgba(179, 64, 46, 0.09);
}

.tool-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted, #a39a8e);
}

.tool-pending .tool-dot { background: #d99a1f; }
.tool-in_progress .tool-dot { background: #3b82f6; }
.tool-completed .tool-dot { background: #4f8a52; }
.tool-failed .tool-dot { background: #b3402e; }

.tool-kind {
  flex: 0 0 auto;
  font-size: 0.625rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.tool-name {
  flex: 0 1 auto;
  max-width: 45%;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-location {
  flex: 1;
  min-width: 0;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

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
}

.message-content :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.125rem 0.5rem;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  color: var(--text-muted, #a39a8e);
}

.spinner {
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

.cancel-btn {
  margin-left: auto;
  height: 24px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  font-family: inherit;
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
  cursor: pointer;
}

.input-container {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.625rem 0.75rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

/* The composer is one control: a single hairline frame wraps the field and
 * the attach button. Everything inside is flex-end so the buttons keep
 * sitting on the last line while the textarea grows. */
.composer-box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 0.375rem;
  padding: 0 0.375rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-lg, 10px);
  background: var(--bg-main, #fbf8f3);
  transition: border-color 0.15s;
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

/* Sent attachments in the transcript: one bordered block per file, stacked,
 * sitting on the message like an artefact rather than running as prose. */
.attachment-blocks {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin: 0.25rem 0 0.5rem;
}

.attachment-block {
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
}

.attachment-line {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.attachment-kind {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.5625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.attachment-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attachment-size {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.attachment-toggle {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 0.6875rem;
  color: var(--text-accent, #c2532f);
  cursor: pointer;
}

.attachment-toggle:hover {
  text-decoration: underline;
}

.attachment-note {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

/* A file that is KNOWN missing (not just unpreviewed) reads as a warning,
   not a quiet aside — the transcript must admit the gap. */
.attachment-missing {
  color: var(--bg-danger, #b3402e);
}

.attachment-image {
  display: block;
  max-width: 100%;
  max-height: 220px;
  margin-bottom: 0.4375rem;
  border-radius: var(--radius-sm, 4px);
}

/* Replayed file content: monospace, bounded height, behind a disclosure. */
.attachment-body {
  margin: 0.5rem 0 0;
  max-height: 260px;
  overflow: auto;
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-secondary, #6b6259);
  white-space: pre-wrap;
  word-break: break-word;
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

/* One quiet line above the row: timer while listening, the reason when a
 * take fails — same size register as .attach-error. */
.voice-status {
  padding: 0 0.125rem;
  font-size: 0.6875rem;
  color: var(--text-muted, #786d62);
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
  /* Reserve space for the floating mobile hamburger (44px wide, fixed in
     App.vue) so the mode/model pickers don't sit underneath it. Also push
     the header below the camera notch / status bar so picker buttons aren't
     clipped on phones with a hole-punch or notch. */
  .chat-header {
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
    padding-left: calc(44px + 1rem);
  }

  /* Agent identity is already shown in the sidebar drawer; on a phone the
     chat header should belong to mode/model/actions. Hiding the long name
     also avoids awkward 4-line wraps for names like "Copilot CLI dev tunnel". */
  .agent-name {
    display: none;
  }

  /* Session title is also redundant on mobile (visible in the sidebar
     SessionList) and otherwise gets crushed to a single character by the
     mode/model pickers. Reclaim the horizontal space. */
  .chat-header h2 {
    display: none;
  }

  .input-container {
    /* iOS home-indicator: keep Send button reachable above the gesture area. */
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
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

  .voice-overlay {
    font-size: 16px;
    line-height: 22px;
    padding-top: 11px;
    padding-bottom: 11px;
  }

  .chat-new-session {
    min-height: 44px;
  }

  /* Touch targets: same square geometry, bumped to 44px. */
  .icon-btn {
    width: 44px;
    height: 44px;
  }

  /* Narrow screens: give the reading column the full width back. */
  .messages-container {
    padding: 0.875rem 0.75rem 0.5rem;
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
