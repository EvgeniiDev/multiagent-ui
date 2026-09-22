<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { marked } from 'marked';
import { useSessionStore } from '../stores/session';
import { isMobile } from '../lib/platform';
import { readAttachments, formatBytes, extractReplayedAttachments, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from '../lib/attachments';
import ModePicker from './ModePicker.vue';
import ModelPicker from './ModelPicker.vue';
import CommandPalette from './CommandPalette.vue';
import type { Attachment, SlashCommand } from '../lib/types';

const sessionStore = useSessionStore();
const inputText = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const commandPaletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);

// Files staged for the next turn, and the last attach error (limits, wrong type).
const attachments = ref<Attachment[]>([]);
const attachError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
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
      attachments: [...(message.attachments ?? []), ...replayed],
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
const isReconnecting = computed(() => sessionStore.isReconnecting);
const currentSession = computed(() => sessionStore.currentSession);
const availableModes = computed(() => sessionStore.availableModes);
const currentModeId = computed(() => sessionStore.currentModeId);
const availableModels = computed(() => sessionStore.availableModels);
const currentModelId = computed(() => sessionStore.currentModelId);
const availableCommands = computed(() => sessionStore.availableCommands);

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

// Auto-scroll to bottom when new messages arrive
watch(messages, async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}, { deep: true });

async function handleSend() {
  const text = inputText.value.trim();
  if ((!text && attachments.value.length === 0) || isLoading.value) return;

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
        <span class="agent-name">{{ currentSession?.agentName }}</span>
      </div>
    </div>
    
    <div ref="messagesContainer" class="messages-container">
      <div class="messages">
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
              <span v-else-if="att.kind === 'image'" class="attachment-note">no preview in history</span>
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

      <div class="input-row">
        <button
          class="attach-btn"
          :class="{ active: attachments.length > 0 }"
          :disabled="isLoading || isReconnecting"
          @click="openFilePicker"
          :title="imageHint"
          aria-label="Attach files"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
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
        <textarea
          v-model="inputText"
          :placeholder="
            isReconnecting
              ? 'Reconnecting…'
              : (availableCommands.length > 0
                  ? 'Type your message... (/ for commands)'
                  : 'Type your message...')
          "
          :disabled="isLoading || isReconnecting"
          @keydown="handleKeyDown"
          rows="3"
        />
        <button 
          class="send-btn"
          :disabled="(!inputText.trim() && attachments.length === 0) || isLoading || isReconnecting"
          @click="handleSend"
        >
          Send
        </button>
      </div>    </div>
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

.agent-name {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  letter-spacing: 0.02em;
  color: var(--text-muted, #a39a8e);
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

/* ---------------- Attachments ---------------- */

/* Quiet square button: hairline, no fill until hover, so it doesn't compete
 * with Send. The glyph is a stroke icon in currentColor, not an emoji — a
 * grayscale-filtered emoji never matched the palette. */
.attach-btn {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  cursor: pointer;
}

.attach-btn:hover:not(:disabled) {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

/* Files staged: the one accent, same as an active row elsewhere. */
.attach-btn.active {
  border-color: var(--bg-primary, #c2532f);
  color: var(--text-accent, #c2532f);
}

.attach-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
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
  background: var(--bg-danger, #b3402e);
  color: #fff;
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

textarea {
  flex: 1;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-lg, 10px);
  font-size: 0.875rem;
  font-family: inherit;
  line-height: 1.45;
  background: var(--bg-main, #fbf8f3);
  color: inherit;
  resize: none;
}

textarea:focus {
  outline: none;
  border-color: var(--text-accent, #c2532f);
}

.send-btn {
  align-self: flex-end;
  height: 32px;
  padding: 0 1rem;
  background: var(--bg-primary, #c2532f);
  color: white;
  border: none;
  border-radius: var(--radius-md, 6px);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover, #a8431f);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

  textarea {
    /* Avoid iOS auto-zoom on focus when font-size < 16px. */
    font-size: 16px;
    min-height: 44px;
  }

  .send-btn {
    min-width: 64px;
    min-height: 44px;
    padding: 0.5rem 1rem;
  }

  .attach-btn {
    width: 44px;
    height: 44px;
    font-size: 1.0625rem;
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
