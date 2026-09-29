<script setup lang="ts">
// One render block inside an expanded workflow node — assistant text,
// collapsible reasoning, a tool card, or a muted lifecycle line (meta).
//
// Text renders via marked+v-html the same way ChatView renders message
// bodies (same trust level: agent output). Everything here is a porch
// preview — data_preview caps at 200 chars, so blocks flagged `truncated`
// carry a "preview truncated" marker instead of pretending to be whole.
import { ref } from 'vue';
import { marked } from 'marked';
import type { EventBlock } from '../../lib/porch/types';

const props = defineProps<{ block: EventBlock }>();
const open = ref(false);

function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}

// Tool input/output are JSON-ish preview strings; mono pre keeps them
// readable without pretending they are full payloads.
</script>

<template>
  <div v-if="props.block.kind === 'text'" class="wf-block wf-text">
    <div class="wf-md" v-html="renderMarkdown(props.block.markdown)" />
    <span v-if="props.block.truncated" class="wf-trunc" title="Preview truncated by porch (200-char cap)">…</span>
  </div>

  <div v-else-if="props.block.kind === 'reasoning'" class="wf-block">
    <button class="wf-reason-toggle" type="button" @click="open = !open">
      {{ open ? '▾' : '▸' }} reasoning
    </button>
    <div v-if="open" class="wf-reasoning">
      {{ props.block.text }}<span v-if="props.block.truncated" class="wf-trunc" title="Preview truncated by porch (200-char cap)">…</span>
    </div>
  </div>

  <div v-else-if="props.block.kind === 'tool'" class="wf-block wf-tool">
    <div class="wf-tool-head">
      <span class="wf-tool-name">{{ props.block.name }}</span>
      <span class="wf-tool-status" :class="props.block.status">{{ props.block.status }}</span>
    </div>
    <pre v-if="props.block.input !== undefined" class="wf-tool-io">{{ props.block.input }}</pre>
    <pre v-if="props.block.output !== undefined" class="wf-tool-io out">{{ props.block.output }}</pre>
    <span v-if="props.block.truncated" class="wf-trunc" title="Preview truncated by porch (200-char cap)">…</span>
  </div>

  <div v-else class="wf-block wf-meta">
    {{ props.block.text }}<span v-if="props.block.truncated" class="wf-trunc" title="Preview truncated by porch (200-char cap)">…</span>
  </div>
</template>

<style scoped>
.wf-block {
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
  min-width: 0;
}

.wf-md {
  color: var(--text-primary, #2b2723);
  font-size: 0.8125rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.wf-md :deep(p) {
  margin: 0 0 0.375rem;
}
.wf-md :deep(p:last-child) {
  margin-bottom: 0;
}
.wf-md :deep(pre) {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  background: var(--bg-assistant, #f1ece4);
  padding: 0.375rem 0.5rem;
  overflow-x: auto;
}
.wf-md :deep(code) {
  font-family: var(--font-mono, monospace);
  font-size: 0.72em;
}
.wf-md :deep(ul),
.wf-md :deep(ol) {
  margin: 0 0 0.375rem;
  padding-left: 1.25rem;
}

.wf-reason-toggle {
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  cursor: pointer;
}
.wf-reason-toggle:hover {
  color: var(--text-secondary, #6b6259);
}
.wf-reasoning {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--text-muted, #a39a8e);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wf-tool {
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  padding: 0.375rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.wf-tool-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}
.wf-tool-name {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-primary, #2b2723);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-tool-status {
  font-size: 0.625rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}
.wf-tool-status.done {
  color: var(--bg-success, #5a7d4f);
}
.wf-tool-io {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wf-tool-io.out {
  color: var(--text-muted, #a39a8e);
}

.wf-meta {
  font-family: var(--font-mono, monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  overflow-wrap: anywhere;
}

.wf-trunc {
  color: var(--text-accent, #c2532f);
  font-family: var(--font-mono, monospace);
}
</style>
