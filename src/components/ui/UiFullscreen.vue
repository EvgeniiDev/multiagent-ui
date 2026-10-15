<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getPlatform, isTauriHost } from '../../lib/platform';
import UiButton from './UiButton.vue';

const browser = !isTauriHost();
const supported = ref(false);
const fullscreen = ref(false);
const standalone = ref(false);
const pending = ref(false);
const error = ref('');
const iphone = getPlatform() === 'ios';

function syncFullscreen() {
  supported.value = !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
  fullscreen.value = !!document.fullscreenElement;
}
async function toggleFullscreen() {
  if (pending.value) return;
  pending.value = true;
  error.value = '';
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    error.value = 'Could not change fullscreen mode. Try again.';
  } finally {
    syncFullscreen();
    pending.value = false;
  }
}
onMounted(() => {
  if (!browser) return;
  standalone.value = window.matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  syncFullscreen();
  document.addEventListener('fullscreenchange', syncFullscreen);
});
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', syncFullscreen));
</script>

<template>
  <div v-if="browser && !standalone" class="fullscreen-control" :class="{ 'is-fullscreen': fullscreen }">
    <UiButton
      v-if="supported"
      class="fullscreen-toggle"
      :disabled="pending"
      :aria-pressed="fullscreen"
      @click="toggleFullscreen"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="fullscreen" d="M9 3v6H3m12-6v6h6M3 15h6v6m6 0v-6h6" />
        <path v-else d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />
      </svg>
      {{ fullscreen ? 'Exit fullscreen' : 'Fullscreen' }}
    </UiButton>
    <p v-else-if="iphone" class="ui-note fullscreen-help">To open without browser bars: Share → Add to Home Screen, then launch ACP UI from its icon.</p>
    <p v-else class="ui-note fullscreen-help">Fullscreen is unavailable in this browser.</p>
    <p v-if="error" class="ui-note" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.fullscreen-control { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.fullscreen-toggle { align-self: flex-start; }
.fullscreen-help { margin: 0; }
@media (min-width: 801px) {
  .fullscreen-control:not(.is-fullscreen) { display: none; }
}
</style>
