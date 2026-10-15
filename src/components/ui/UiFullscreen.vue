<script lang="ts">
// Shared by session tabs; exiting fullscreen opts out until the page reloads.
let automaticFullscreenSuppressed = false;
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getPlatform, isTauriHost } from '../../lib/platform';
import UiButton from './UiButton.vue';

const browser = !isTauriHost();
const control = ref<HTMLElement | null>(null);
let swipeStart: { x: number; y: number } | null = null;
const supported = ref(false);
const fullscreen = ref(false);
const standalone = ref(false);
const pending = ref(false);
const error = ref('');
const iphone = getPlatform() === 'ios';

function syncFullscreen() {
  supported.value = !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
  const active = !!document.fullscreenElement;
  if (fullscreen.value && !active) automaticFullscreenSuppressed = true;
  fullscreen.value = active;
}
function onTouchStart(event: TouchEvent) {
  swipeStart = null;
  if (!event.isTrusted || automaticFullscreenSuppressed || pending.value || fullscreen.value ||
      !supported.value || standalone.value || !window.matchMedia('(max-width: 800px)').matches ||
      !document.documentElement.classList.contains('document-chat') || event.touches.length !== 1 ||
      !(event.target instanceof Element)) return;
  const feed = event.target.closest('.messages-container');
  if (!feed?.closest('.chat-view')?.contains(control.value)) return;
  const touch = event.touches[0]!;
  swipeStart = { x: touch.clientX, y: touch.clientY };
}
function onTouchMove(event: TouchEvent) {
  if (event.touches.length !== 1) swipeStart = null;
}
function cancelSwipe() { swipeStart = null; }
function onTouchEnd(event: TouchEvent) {
  const start = swipeStart;
  swipeStart = null;
  if (!event.isTrusted || !start || event.touches.length || automaticFullscreenSuppressed ||
      pending.value || document.fullscreenElement || !navigator.userActivation?.isActive) return;
  const touch = event.changedTouches[0];
  if (!touch) return;
  const down = start.y - touch.clientY;
  if (down < 32 || down < Math.abs(start.x - touch.clientX) * 2) return;
  // Request during the trusted gesture, never from scroll/replay/stream events.
  void toggleFullscreen(true);
}
async function toggleFullscreen(automatic = false) {
  if (pending.value) return;
  pending.value = true;
  error.value = '';
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    if (automatic) automaticFullscreenSuppressed = true;
    else error.value = 'Could not change fullscreen mode. Try again.';
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
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', cancelSwipe, { passive: true });
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreen);
  document.removeEventListener('touchstart', onTouchStart);
  document.removeEventListener('touchmove', onTouchMove);
  document.removeEventListener('touchend', onTouchEnd);
  document.removeEventListener('touchcancel', cancelSwipe);
});
</script>

<template>
  <div v-if="browser && !standalone" ref="control" class="fullscreen-control" :class="{ 'is-fullscreen': fullscreen }">
    <UiButton
      v-if="supported"
      class="fullscreen-toggle"
      :disabled="pending"
      :aria-pressed="fullscreen"
      @click="toggleFullscreen()"
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
