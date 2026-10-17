<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ modelValue: number }>();
const emit = defineEmits<{ 'update:modelValue': [width: number] }>();
const STORAGE_KEY = 'acp-ui:sidebar-width';
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 240;
const viewport = ref(window.innerWidth);
const maximum = computed(() => Math.max(MIN_WIDTH, Math.min(560, viewport.value - 420)));
const dragging = ref(false);
let preferredWidth = props.modelValue;
let drag: { pointerId: number; x: number; width: number; preferred: number } | null = null;

function apply(width: number) {
  emit('update:modelValue', Math.round(Math.max(MIN_WIDTH, Math.min(maximum.value, width))));
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, String(preferredWidth)); } catch { /* Resize still works without storage. */ }
}
function resizeViewport() {
  viewport.value = window.innerWidth;
  apply(preferredWidth);
}
function start(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, x: event.clientX, width: props.modelValue, preferred: preferredWidth };
  dragging.value = true;
}
function move(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  preferredWidth = Math.max(MIN_WIDTH, Math.min(maximum.value, drag.width + event.clientX - drag.x));
  apply(preferredWidth);
}
function finish(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag = null;
  dragging.value = false;
  save();
}
function cancel() {
  if (!drag) return;
  preferredWidth = drag.preferred;
  drag = null;
  dragging.value = false;
  apply(preferredWidth);
}
function reset() {
  preferredWidth = DEFAULT_WIDTH;
  apply(preferredWidth);
  save();
}
onMounted(() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const value = Number(saved);
    if (saved !== null && Number.isFinite(value) && value >= MIN_WIDTH && value <= 560) preferredWidth = value;
  } catch { /* Keep the default when storage is unavailable. */ }
  resizeViewport();
  window.addEventListener('resize', resizeViewport);
});
onBeforeUnmount(() => {
  cancel();
  window.removeEventListener('resize', resizeViewport);
});
</script>

<template>
  <div
    class="sidebar-resize"
    :class="{ dragging }"
    role="separator"
    aria-label="Resize chat sidebar"
    aria-controls="app-sidebar"
    aria-orientation="vertical"
    :aria-valuemin="MIN_WIDTH"
    :aria-valuemax="maximum"
    :aria-valuenow="modelValue"
    title="Drag to resize · Double-click to reset"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="finish"
    @pointercancel="cancel"
    @lostpointercapture="cancel"
    @dblclick="reset"
  />
</template>

<style scoped>
.sidebar-resize {
  position: absolute;
  inset: 0 -4px 0 auto;
  width: 9px;
  z-index: 5;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
.sidebar-resize::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
}
.sidebar-resize:hover::after,
.sidebar-resize.dragging::after { background: var(--border-strong); }
</style>
