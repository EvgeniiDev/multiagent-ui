<script setup lang="ts">
// One attachment block inside a transcript message — image preview or a
// named file line with a modal preview and download. Appearance is
// self-contained: nothing here may rely on a parent's scoped styles.
import { computed, ref, watch } from 'vue';
import type { AttachmentMeta } from '../lib/types';
import { formatBytes } from '../lib/attachments';
import UiImagePreview from './ui/UiImagePreview.vue';
import UiButton from './ui/UiButton.vue';
import UiFilePreview from './ui/UiFilePreview.vue';
import { chatFileFromLink, type ChatFile } from '../lib/chatFiles';

const props = defineProps<{
  cwd?: string;
  active?: boolean;
  att: AttachmentMeta;
}>();

const selected = ref<ChatFile | null>(null);
const file = computed<ChatFile | null>(() => {
  const att = props.att;
  if (att.previewUrl) return { name: att.name, url: att.previewUrl, mimeType: att.mimeType };
  return att.uri ? chatFileFromLink(att.uri, props.cwd, true) : null;
});
watch(() => props.active, active => { if (active === false) selected.value = null; });
function show() {
  const att = props.att;
  if (file.value) { selected.value = file.value; return; }
  if (att.body == null) return;
  // Defer encoding until asked to view, rather than copying every replayed body.
  selected.value = { name: att.name, url: `data:${att.mimeType || 'text/plain'};charset=utf-8,${encodeURIComponent(att.body)}`, mimeType: att.mimeType };
}
</script>

<template>
  <div class="attachment-block">
    <UiFilePreview :file="selected" @close="selected = null" />
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
      <UiButton v-if="file || att.body != null" size="xs" @click="show">View file</UiButton>
      <!-- An image/file whose bytes could not be recovered is a named
           placeholder with a reason — never a silent gap. -->
      <span
        v-else-if="att.unavailableReason"
        class="attachment-note attachment-missing"
      >{{ att.unavailableReason }}</span>
      <span v-else-if="att.kind === 'image' && !att.previewUrl" class="attachment-note">no preview in history</span>
    </div>
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
  align-items: center;
  flex-wrap: wrap;
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

.attachment-note {
  flex: 1 1 100%;
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

</style>
