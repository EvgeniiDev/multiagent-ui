<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
// One tool call inside a transcript message — a dense chip whose dot carries
// status; calls with arguments or output expand behind a quiet disclosure.
// Appearance is self-contained: nothing here may rely on a parent's styles.
import type { ToolCallInfo } from '../lib/types';

defineProps<{
  tc: ToolCallInfo;
  /** Whether the args/output disclosure is open (state lives in the parent,
   *  keyed by toolCallId, so it survives the render window). */
  expanded: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

// Pretty-printed call arguments / outputs, truncated to ~4KB with an ellipsis note.
const TOOL_ARGS_MAX_CHARS = 4096;

function truncateToolText(text: string): string {
  if (text.length > TOOL_ARGS_MAX_CHARS) {
    return text.slice(0, TOOL_ARGS_MAX_CHARS) + '\n… (truncated, showing first 4KB)';
  }
  return text;
}

function formatToolArgs(rawInput: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(rawInput, null, 2) ?? 'undefined';
  } catch {
    text = String(rawInput);
  }
  return truncateToolText(text);
}

/** Expanded body: args section first, then output; absent sections skipped. */
function formatToolBody(rawInput: unknown, rawOutput: string | undefined): string {
  const parts: string[] = [];
  if (rawInput != null) parts.push('args:\n' + formatToolArgs(rawInput));
  if (rawOutput) parts.push('output:\n' + truncateToolText(rawOutput));
  return parts.join('\n\n');
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
  <div class="tool-call-wrap">
    <UiButton variant="transcript" :tone="tc.status === 'failed' ? 'danger' : tc.status === 'in_progress' ? 'info' : 'default'"
      v-if="tc.rawInput != null || tc.rawOutput"
      :class="['tool-call-inline', 'is-expandable', `tool-${tc.status}`]"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <span class="tool-dot" aria-hidden="true"></span>
      <span class="tool-kind">{{ getToolKind(tc.kind) }}</span>
      <span class="tool-name">{{ tc.title }}</span>
      <span v-if="tc.locations?.length" class="tool-location">
        {{ tc.locations[0].path }}
      </span>
      <span class="tool-chevron">{{ expanded ? '▾' : '▸' }}</span>
    </UiButton>
    <div v-else :class="['tool-call-inline', `tool-${tc.status}`]">
      <span class="tool-dot" aria-hidden="true"></span>
      <span class="tool-kind">{{ getToolKind(tc.kind) }}</span>
      <span class="tool-name">{{ tc.title }}</span>
      <span v-if="tc.locations?.length" class="tool-location">
        {{ tc.locations[0].path }}
      </span>
    </div>
    <pre
      v-if="(tc.rawInput != null || tc.rawOutput) && expanded"
      class="tool-args"
    >{{ formatToolBody(tc.rawInput, tc.rawOutput) }}</pre>
  </div>
</template>

<style scoped>
.tool-call-wrap {
  min-width: 0;
}

.tool-call-inline:not(.ds-button) {
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
.tool-call-inline.is-expandable { width: 100%; }

.tool-call-inline:not(.ds-button).tool-failed { background: var(--accent-danger-soft); }
.tool-call-inline:not(.ds-button).tool-in_progress { background: var(--surface-info); }

.tool-chevron {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

/* Call arguments: quiet pre behind the chip, same register as thought body. */
.tool-args {
  margin: 2px 0 0;
  max-height: 260px;
  overflow: auto;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-md, 6px);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-secondary, #6b6259);
  white-space: pre-wrap;
  word-break: break-word;
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
</style>
