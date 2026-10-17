<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import UiButton from './UiButton.vue';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

const props = defineProps<{ url: string; thumbnail?: boolean }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const container = ref<HTMLElement | null>(null);
const page = ref(1);
const pages = ref(0);
const busy = ref(true);
const error = ref('');
let task: PDFDocumentLoadingTask | undefined;
let document: PDFDocumentProxy | undefined;
let renderTask: RenderTask | undefined;
let disposed = false;
async function render(number: number) {
  if (!document || disposed || !canvas.value) return;
  busy.value = true;
  error.value = '';
  try {
    const pdfPage = await document.getPage(number);
    if (disposed || !canvas.value) return;
    const width = Math.max(200, Math.min(container.value?.clientWidth || 800, props.thumbnail ? 300 : 1400));
    const original = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: Math.min(width / original.width, 2) });
    const ratio = props.thumbnail ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const target = canvas.value;
    target.width = Math.floor(viewport.width * ratio);
    target.height = Math.floor(viewport.height * ratio);
    target.style.width = `${viewport.width}px`;
    target.style.height = `${viewport.height}px`;
    renderTask = pdfPage.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    await renderTask.promise;
    page.value = number;
  } catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : 'Could not display this PDF'; }
  finally { if (!disposed) busy.value = false; }
}
onMounted(async () => {
  try {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    if (disposed) return;
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const resources = import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : `${import.meta.env.BASE_URL}${import.meta.env.VITE_PDF_ASSET_DIR}/`;
    task = pdfjs.getDocument({ url: props.url, useSystemFonts: true,
      cMapUrl: `${resources}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${resources}standard_fonts/`, wasmUrl: `${resources}wasm/`,
    });
    document = await task.promise;
    if (disposed) return;
    pages.value = document.numPages;
    await nextTick();
    await render(1);
  } catch (e) { if (!disposed) { error.value = e instanceof Error ? e.message : 'Could not open this PDF'; busy.value = false; } }
});
onBeforeUnmount(() => { disposed = true; renderTask?.cancel(); void task?.destroy(); });
</script>

<template>
  <div ref="container" class="pdf-preview" :class="{ thumbnail }">
    <nav v-if="!thumbnail" class="pdf-pages" aria-label="PDF pages">
      <UiButton :disabled="busy || page <= 1" @click="render(page - 1)">Previous</UiButton>
      <span>Page {{ page }} / {{ pages || '…' }}</span>
      <UiButton :disabled="busy || page >= pages" @click="render(page + 1)">Next</UiButton>
    </nav>
    <p v-if="busy" role="status">Rendering PDF…</p>
    <p v-if="error" role="alert">{{ error }}. You can still download the PDF.</p>
    <canvas ref="canvas" :aria-label="`PDF page ${page}`" role="img" />
  </div>
</template>

<style scoped>
.pdf-preview { min-width: 0; width: 100%; }
.pdf-pages { position: sticky; top: -1rem; display: flex; align-items: center; justify-content: center; gap: 0.75rem; padding: 0.5rem 0; background: var(--bg-main); }
.pdf-pages span { font-size: 0.75rem; color: var(--text-secondary); }
.thumbnail canvas { max-height: 180px; width: auto !important; height: auto !important; margin: 0 auto; }
canvas { display: block; max-width: 100%; height: auto !important; margin: 0.5rem auto; background: white; }
p { font-size: 0.875rem; color: var(--text-secondary); }
</style>
