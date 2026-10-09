<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import UiButton from './UiButton.vue';

const root = ref<HTMLElement | null>(null);
const open = ref(false);
function closeOutside(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false;
}
onMounted(() => window.addEventListener('click', closeOutside));
onBeforeUnmount(() => window.removeEventListener('click', closeOutside));
</script>

<template>
  <div ref="root" class="composer-settings" :class="{ 'is-open': open }" @keydown.esc.stop="open = false">
    <UiButton
      class="settings-toggle"
      variant="ghost"
      icon
      aria-label="Chat settings"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <path d="M4 7h16M4 17h16M8 4v6M16 14v6" />
      </svg>
    </UiButton>
    <div class="settings-panel" role="group" aria-label="Chat settings">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.composer-settings, .settings-panel { display: contents; }
.settings-toggle { display: none; }
@media (max-width: 800px) {
  .composer-settings { display: block; flex: 0 0 auto; }
  .settings-toggle { display: inline-flex; }
  .settings-panel {
    display: none;
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 0.5rem);
    z-index: 150;
    padding: 0.75rem;
    max-height: min(360px, 55dvh);
    overflow-y: auto;
    gap: 0.5rem;
    background: var(--bg-main);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg, 10px);
    box-shadow: 0 4px 16px var(--tint-active);
  }
  .is-open .settings-panel { display: grid; }
}
</style>
