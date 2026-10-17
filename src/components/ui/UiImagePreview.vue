<script setup lang="ts">
import { nextTick, ref } from 'vue';
import UiButton from './UiButton.vue';

defineProps<{ src: string; name: string; compact?: boolean }>();

const dialog = ref<HTMLDialogElement | null>(null);
const open = ref(false);
const loading = ref(false);
const failed = ref(false);

async function show() {
  open.value = true;
  loading.value = true;
  failed.value = false;
  await nextTick();
  dialog.value?.showModal();
}

function close() {
  dialog.value?.close();
}
</script>

<template>
  <span class="preview-trigger">
  <UiButton variant="image" :aria-label="`Preview ${name}`" :title="`Preview ${name}`" @click="show">
    <img :src="src" :alt="name" class="preview-thumbnail" :class="{ compact }" />
  </UiButton>
  <Teleport to="body">
    <!-- Native modal dialog provides focus trapping, Escape and focus return. -->
    <dialog v-if="open" ref="dialog" class="image-preview" aria-label="Image preview" @close="open = false" @click.self="close">
      <header class="preview-header">
        <span class="preview-name" :title="name">{{ name }}</span>
        <UiButton icon aria-label="Close image preview" autofocus @click="close">×</UiButton>
      </header>
      <div class="preview-content">
        <p v-if="loading" role="status">Loading image…</p>
        <p v-if="failed" role="alert">Could not load this image. Close the preview and try again.</p>
        <img :src="src" :alt="name" class="preview-image" :hidden="failed" @load="loading = false" @error="loading = false; failed = true" />
      </div>
    </dialog>
  </Teleport>
  </span>
</template>

<style scoped>
.preview-trigger { display: inline-flex; max-width: 100%; min-width: 0; }
.preview-thumbnail { display: block; max-width: 100%; max-height: 220px; object-fit: contain; }
.preview-thumbnail.compact { width: 44px; height: 44px; object-fit: cover; }
.image-preview {
  box-sizing: border-box;
  width: min(1100px, calc(100vw - 32px));
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg, 10px);
  background: var(--bg-main);
  color: var(--text-primary);
}
.image-preview::backdrop { background: rgb(0 0 0 / 75%); }
.preview-header { display: flex; align-items: center; gap: 1rem; padding: 0.75rem; border-bottom: 1px solid var(--border-color); }
.preview-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.875rem; }
.preview-content { padding: 0.75rem; text-align: center; }
.preview-content p { color: var(--text-secondary); font-size: 0.875rem; }
.preview-image { max-width: 100%; max-height: calc(100dvh - 140px); object-fit: contain; vertical-align: middle; }
</style>
