<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import UiButton from './UiButton.vue';

const props = withDefaults(defineProps<{ label: string; active?: boolean; anchor?: HTMLElement }>(), { active: true });
const id = useId();
const root = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const opened = ref(false);
const pinned = ref(false);
const position = ref<Record<string, string>>({});
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
const trigger = () => root.value?.querySelector('button');

function cancelHover() { clearTimeout(hoverTimer); }
function close(restoreFocus = false) {
  cancelHover();
  panel.value?.hidePopover();
  opened.value = false;
  pinned.value = false;
  if (restoreFocus) trigger()?.focus();
}
function place() {
  const box = trigger()?.getBoundingClientRect();
  if (!box) return;
  const boundary = props.anchor?.getBoundingClientRect() ?? box;
  const width = Math.min(340, window.innerWidth - 16);
  const above = boundary.top - 14;
  const below = window.innerHeight - boundary.bottom - 14;
  const upwards = above >= 180 || above > below;
  position.value = {
    left: `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`,
    width: `${width}px`, maxHeight: `${Math.max(60, upwards ? above : below)}px`,
    ...(upwards ? { bottom: `${window.innerHeight - boundary.top + 6}px` } : { top: `${boundary.bottom + 6}px` }),
  };
}
function open(pin = false) {
  cancelHover();
  if (!props.active || !panel.value) return;
  place();
  pinned.value ||= pin;
  panel.value.showPopover();
  opened.value = true;
}
function toggle() { pinned.value ? close() : open(true); }
function enter(event: PointerEvent) {
  cancelHover();
  if (event.pointerType === 'mouse' && matchMedia('(hover: hover)').matches) hoverTimer = setTimeout(() => open(), 180);
}
function leave() {
  cancelHover();
  if (!pinned.value) hoverTimer = setTimeout(() => {
    if (!root.value?.contains(document.activeElement)) close();
  }, 220);
}
function syncOpen() {
  opened.value = panel.value?.matches(':popover-open') ?? false;
  if (!opened.value) { pinned.value = false; cancelHover(); }
}
function focusOut(event: FocusEvent) {
  // A focused Refresh button becomes disabled while loading. Browsers report
  // relatedTarget=null then; keep the card open until focus actually leaves it.
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) close();
}
function scroll(event: Event) {
  if (opened.value && !panel.value?.contains(event.target as Node)) place();
}
watch(() => props.active, active => { if (!active) close(); });
onMounted(() => { window.addEventListener('resize', closeOnResize); window.addEventListener('scroll', scroll, true); });
function closeOnResize() { close(); }
onBeforeUnmount(() => { cancelHover(); window.removeEventListener('resize', closeOnResize); window.removeEventListener('scroll', scroll, true); });
</script>

<template>
  <div ref="root" class="usage-meter" @focusout="focusOut" @keydown.esc.stop.prevent="close(true)">
    <UiButton class="context-meter" variant="meter" aria-label="Context and subscription limits"
      aria-haspopup="dialog" :aria-expanded="opened" :aria-controls="id"
      @click="toggle" @pointerenter="enter" @pointerleave="leave">{{ label || 'Limits' }}</UiButton>
    <div ref="panel" :id="id" popover="auto" role="dialog" aria-label="Session usage"
      class="usage-popover" :style="position" @toggle="syncOpen" @pointerenter="cancelHover" @pointerleave="leave">
      <template v-if="opened">
        <div class="usage-heading"><h3>Session usage</h3><UiButton variant="ghost" icon size="xs" aria-label="Close usage details" @click="close(true)">×</UiButton></div>
        <slot />
      </template>
    </div>
  </div>
</template>

<style scoped>
.usage-meter { flex: 0 0 auto; display: inline-flex; }
.usage-popover { position: fixed; inset: auto; margin: 0; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; padding: 1rem; background: var(--bg-assistant); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); box-shadow: 0 4px 16px var(--tint-active); }
.usage-heading { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .5rem; }
h3 { margin: 0; font-size: .85rem; }
</style>
