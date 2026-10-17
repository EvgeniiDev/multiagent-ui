<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';
import UiButton from './UiButton.vue';
import UiPdfPreview from './UiPdfPreview.vue';
import UiMarkdownDocument from './UiMarkdownDocument.vue';
import { fetchChatFile, previewKind, downloadChatBlob, isMarkdownFile, type ChatFile } from '../../lib/chatFiles';
import { formatBytes } from '../../lib/attachments';

const props = defineProps<{ file: ChatFile | null }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const loading = ref(false);
const error = ref('');
const blob = ref<Blob | null>(null);
const url = ref('');
const text = ref('');
const kind = ref('binary');
let controller: AbortController | undefined;
let generation = 0;
function cleanup() {
  controller?.abort();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = '';
  blob.value = null;
  text.value = '';
}
async function load() {
  const file = props.file;
  const current = ++generation;
  cleanup();
  error.value = '';
  if (!file) { dialog.value?.close(); return; }
  loading.value = true;
  controller = new AbortController();
  const signal = controller.signal;
  await nextTick();
  if (current !== generation || signal.aborted) return;
  if (!dialog.value?.open) dialog.value?.showModal();
  try {
    const result = await fetchChatFile(file, signal);
    if (signal.aborted || current !== generation) return;
    blob.value = result;
    kind.value = previewKind(file, result.type);
    if (kind.value === 'text') {
      // Keep large logs downloadable without freezing the transcript or dialog.
      let content = await result.slice(0, 512 * 1024).text();
      if (result.size > 512 * 1024) content += '\n\n… Preview limited to 512 KB. Download to read the complete file.';
      if (signal.aborted || current !== generation) return;
      text.value = content;
    }
    if (kind.value === 'image' || kind.value === 'pdf') url.value = URL.createObjectURL(result);
  } catch (e) {
    if (!signal.aborted && current === generation) error.value = e instanceof Error ? e.message : 'Could not open file';
  } finally { if (current === generation) loading.value = false; }
}
function close() { emit('close'); }
watch(() => props.file, load, { immediate: true });
onBeforeUnmount(() => { generation++; cleanup(); });
</script>

<template>
  <Teleport to="body">
    <dialog v-if="file" ref="dialog" class="file-preview" aria-label="File preview" @cancel.prevent="close" @close="close" @click.self="close">
      <header class="file-header">
        <div class="file-heading"><strong :title="file.name">{{ file.name }}</strong><span v-if="blob">{{ formatBytes(blob.size) }}</span></div>
        <UiButton :disabled="!blob || loading" @click="blob && downloadChatBlob(blob, file.name)">Download</UiButton>
        <UiButton icon aria-label="Close file preview" autofocus @click="close">×</UiButton>
      </header>
      <section class="file-content" :aria-busy="loading">
        <p v-if="loading" role="status">Loading file…</p>
        <div v-else-if="error" class="file-error" role="alert"><p>{{ error }}</p><UiButton @click="load">Try again</UiButton></div>
        <template v-else-if="blob">
          <img v-if="kind === 'image'" :src="url" :alt="file.name" @error="error = 'Could not display this image. You can still download the file.'" />
          <UiPdfPreview v-else-if="kind === 'pdf'" :url="url" />
          <UiMarkdownDocument v-else-if="kind === 'text' && isMarkdownFile(file)" :text="text" />
          <pre v-else-if="kind === 'text'">{{ text }}</pre>
          <p v-else>Preview is unavailable for this format. You can download the file.</p>
        </template>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.file-preview { box-sizing: border-box; margin: auto; width: min(1100px, calc(100vw - 24px)); max-width: calc(100vw - 24px); height: min(850px, calc(100dvh - 24px)); max-height: calc(100dvh - 24px); padding: 0; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-main); color: var(--text-primary); overflow: hidden; }
.file-preview[open] { display: flex; flex-direction: column; }
.file-preview::backdrop { background: rgb(0 0 0 / 75%); }
.file-header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.5rem; padding: 0.75rem; border-bottom: 1px solid var(--border-color); }
.file-heading { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.file-heading strong { font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-heading span { color: var(--text-muted); font-size: 0.75rem; }
.file-content { flex: 1; min-height: 0; overflow: auto; padding: 1rem; text-align: center; }
.file-content img { max-width: 100%; height: auto; object-fit: contain; }
.file-content pre { margin: 0; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; font: 0.8125rem/1.6 var(--font-mono); color: var(--text-primary); }
.file-content p { color: var(--text-secondary); font-size: 0.875rem; }
.file-error { display: grid; justify-items: center; gap: 0.5rem; }
</style>
