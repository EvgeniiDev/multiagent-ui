<script setup lang="ts">
// One attachment block inside a transcript message — image preview or a
// named file line, with the replayed body behind a disclosure. Appearance is
// self-contained: nothing here may rely on a parent's scoped styles.
import type { AttachmentMeta } from '../lib/types';
import { formatBytes } from '../lib/attachments';
import UiImagePreview from './ui/UiImagePreview.vue';

defineProps<{
  att: AttachmentMeta;
  /** Whether the replayed file body disclosure is open (state lives in the
   *  parent, keyed by message id + index, so it survives the render window). */
  expanded: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="attachment-block">
    <UiImagePreview
      v-if="att.kind === 'image' && att.previewUrl"
      :src="att.previewUrl"
      :name="att.name"
      class="attachment-image"
    />
    <div class="attachment-line">
      <span class="attachment-kind">{{ att.kind }}</span>
      <span class="attachment-name" :title="att.name">{{ att.name }}</span>
      <span v-if="att.size" class="attachment-size">{{ formatBytes(att.size) }}</span>
      <button
        v-if="att.body"
        class="attachment-toggle"
        @click="emit('toggle')"
      >
        {{ expanded ? 'Hide file' : 'Show file' }}
      </button>
      <!-- An image/file whose bytes could not be recovered is a named
           placeholder with a reason — never a silent gap. -->
      <span
        v-else-if="att.unavailableReason"
        class="attachment-note attachment-missing"
      >{{ att.unavailableReason }}</span>
      <span v-else-if="att.kind === 'image' && !att.previewUrl" class="attachment-note">no preview in history</span>
    </div>
    <pre v-if="att.body && expanded" class="attachment-body">{{ att.body }}</pre>
  </div>
</template>

<style scoped>
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
  margin-bottom: 0.4375rem;
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
</style>
