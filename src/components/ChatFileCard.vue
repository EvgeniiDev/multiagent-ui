<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import UiButton from './ui/UiButton.vue';
import UiPdfPreview from './ui/UiPdfPreview.vue';
import UiMarkdownDocument from './ui/UiMarkdownDocument.vue';
import { fetchChatFile, previewKind, isMarkdownFile, type ChatFile } from '../lib/chatFiles';
import { formatBytes } from '../lib/attachments';

const props = withDefaults(defineProps<{ file: ChatFile; active?: boolean }>(), { active: true });
const emit = defineEmits<{ open: [file: ChatFile] }>();
const element = ref<HTMLElement | null>(null);
const visible = ref(false);
const loading = ref(false);
const error = ref('');
const blob = ref<Blob | null>(null);
const text = ref('');
const url = ref('');
const kind = computed(() => previewKind(props.file));
const markdown = computed(() => isMarkdownFile(props.file));
const label = computed(() => kind.value === 'pdf' ? 'PDF' : markdown.value ? 'MARKDOWN' : 'TEXT');
let observer: IntersectionObserver | undefined;
let controller: AbortController | undefined;
let generation = 0;
function cleanup() {
  controller?.abort();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = ''; blob.value = null; text.value = ''; loading.value = false;
}
async function load() {
  const current = ++generation;
  cleanup(); error.value = '';
  if (!visible.value || !props.active) return;
  const file = props.file;
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  try {
    const result = await fetchChatFile(file, signal);
    const content = kind.value === 'text' ? (await result.slice(0, 8192).text()).slice(0, 2000) : '';
    if (signal.aborted || current !== generation) return;
    blob.value = result;
    text.value = content;
    if (kind.value === 'pdf') url.value = URL.createObjectURL(result);
  } catch (e) {
    if (!signal.aborted && current === generation) error.value = e instanceof Error ? e.message : 'Could not load preview';
  } finally { if (current === generation) loading.value = false; }
}
function open() { emit('open', { ...props.file, blob: blob.value || undefined }); }
watch([visible, () => props.active, () => props.file.url, () => props.file.text, () => props.file.blob, () => props.file.mimeType], load);
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible.value = entries.some(entry => entry.isIntersecting); }, { rootMargin: '200px' });
  if (element.value) observer.observe(element.value);
});
onBeforeUnmount(() => { generation++; observer?.disconnect(); cleanup(); });
</script>

<template>
  <article ref="element" class="file-card" :data-file-name="file.name" :aria-label="`${file.name} preview`">
    <header>
      <span class="file-kind">{{ label }}</span>
      <strong :title="file.name">{{ file.name }}</strong>
      <span v-if="blob" class="file-size">{{ formatBytes(blob.size) }}</span>
      <UiButton variant="ghost" size="xs" @click="open">Open</UiButton>
    </header>
    <div class="card-preview" :aria-busy="loading">
      <p v-if="loading" role="status">Loading preview…</p>
      <div v-else-if="error" class="preview-error"><p role="alert">{{ error }}</p><UiButton size="xs" @click="load">Try again</UiButton></div>
      <template v-else-if="blob">
        <UiPdfPreview v-if="kind === 'pdf' && url" :url="url" thumbnail />
        <UiMarkdownDocument v-else-if="markdown" :text="text" />
        <pre v-else>{{ text || 'Empty file' }}</pre>
      </template>
      <p v-else class="preview-placeholder">{{ kind === 'pdf' ? 'First page preview' : 'Text preview' }}</p>
    </div>
  </article>
</template>

<style scoped>
.file-card { min-width: 0; width: 100%; box-sizing: border-box; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-assistant); overflow: hidden; }
header { display: flex; align-items: center; gap: 0.5rem; min-width: 0; min-height: 36px; padding: 0 0.5rem; border-bottom: 1px solid var(--border-faint); }
.file-kind { flex: 0 0 auto; font: 0.5625rem var(--font-mono); letter-spacing: 0.04em; color: var(--text-muted); }
strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font: 500 0.8125rem var(--font-ui); }
.file-size { font: 0.625rem var(--font-mono); color: var(--text-muted); white-space: nowrap; }
.card-preview { position: relative; padding: 0.75rem; height: 180px; overflow: hidden; }
.card-preview::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 18px; background: linear-gradient(transparent, var(--bg-assistant)); pointer-events: none; }
pre { margin: 0; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; font: 0.75rem/1.6 var(--font-mono); }
p { margin: 0.5rem 0; color: var(--text-muted); font: 0.75rem/1.5 var(--font-ui); }
.preview-error { display: grid; justify-items: start; gap: 0.5rem; }
@media (max-width: 480px) { .file-size { display: none; } }
</style>
