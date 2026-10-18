<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import UiButton from './UiButton.vue';

const props = withDefaults(defineProps<{
  phase: 'idle' | 'connecting' | 'listening' | 'stopping';
  canSend: boolean;
  stopResponse: boolean;
  disabled: boolean;
  active: boolean;
  voiceUnavailable?: string;
}>(), { voiceUnavailable: '' });
const emit = defineEmits<{
  record: [];
  send: [];
  'stop-response': [];
  'stop-recording': [];
  'cancel-recording': [];
}>();
const HOLD_MS = 350;
const LOCK_DISTANCE = 48;
const locked = ref(false);
const held = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let press: { id: number; x: number; y: number; started: boolean; lockRequested: boolean } | null = null;
let suppressClick = false;
const recording = computed(() => props.phase === 'connecting' || props.phase === 'listening');
const stopsResponse = computed(() => props.stopResponse && props.phase === 'idle');
const label = computed(() => props.phase === 'connecting' ? 'Starting microphone' : recording.value ? (locked.value ? 'Send voice message' : 'Recording voice message')
  : props.phase === 'stopping' ? 'Finishing transcription'
  : stopsResponse.value ? 'Stop response' : props.canSend ? 'Send' : 'Record voice message');
const title = computed(() => props.phase === 'connecting' ? 'Starting microphone… Release to cancel' : recording.value ? (locked.value ? 'Tap to finish and send' : 'Release to send · Slide up to lock')
  : props.voiceUnavailable && !props.canSend && !stopsResponse.value ? props.voiceUnavailable
  : `${label.value} · Hold to record · Slide up to lock`);

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}
function begin(lock = false) {
  clearTimer();
  if (!press || props.disabled || props.phase !== 'idle') return;
  press.started = true;
  suppressClick = true;
  held.value = true;
  locked.value = lock;
  emit('record');
}
function pointerdown(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || props.disabled) return;
  suppressClick = false;
  if (props.phase !== 'idle') return;
  press = { id: event.pointerId, x: event.clientX, y: event.clientY, started: false, lockRequested: false };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  timer = setTimeout(() => begin(press?.lockRequested ?? false), HOLD_MS);
}
function pointermove(event: PointerEvent) {
  if (!press || press.id !== event.pointerId) return;
  if (event.clientY - press.y <= -LOCK_DISTANCE && Math.abs(event.clientX - press.x) < 80) {
    if (!press.started) press.lockRequested = true;
    else if (recording.value) locked.value = true;
  } else if (!press.started && (Math.abs(event.clientX - press.x) > 16 || event.clientY - press.y > 16)) {
    clearTimer();
    press = null;
    suppressClick = true;
  }
}
function pointerup(event: PointerEvent) {
  if (!press || press.id !== event.pointerId) return;
  clearTimer();
  const started = press.started;
  if (!started && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 16) suppressClick = true;
  press = null;
  held.value = false;
  if (!started || locked.value) return;
  if (props.phase === 'listening') emit('send');
  else if (props.phase === 'connecting') emit('cancel-recording');
}
function cancelPress() {
  if (!press) return;
  clearTimer();
  const started = press.started;
  press = null;
  held.value = false;
  suppressClick = true;
  if (started && !locked.value) emit('stop-recording');
}
function click(event: MouseEvent) {
  if (suppressClick) { suppressClick = false; if (event.detail > 0) return; }
  if (props.disabled || props.phase === 'stopping') return;
  if (props.phase === 'connecting') { emit('cancel-recording'); return; }
  if (props.phase === 'listening') { emit('send'); return; }
  if (stopsResponse.value) { emit('stop-response'); return; }
  if (props.canSend) { emit('send'); return; }
  // Keyboard / screen-reader activation provides the same hands-free mode.
  if (event.detail === 0) { locked.value = true; emit('record'); }
}
watch(() => props.phase, phase => {
  if (phase === 'idle') { locked.value = false; held.value = false; }
});
watch(() => props.active, active => {
  if (active) return;
  clearTimer();
  press = null;
  held.value = false;
  locked.value = false;
  suppressClick = true;
  if (recording.value) emit('stop-recording');
});
onBeforeUnmount(clearTimer);
</script>

<template>
  <div class="send-voice-control">
    <div v-if="recording && held" class="voice-gesture-hint" role="status">
      <span>{{ phase === 'connecting' ? 'Starting microphone…' : locked ? 'Recording locked · Tap to send' : '↑ Slide up to lock' }}</span>
    </div>
    <UiButton v-if="recording && locked" variant="ghost" icon aria-label="Cancel voice recording" title="Cancel recording" @click.stop="emit('cancel-recording')">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </UiButton>
    <UiButton
      icon
      class="voice-btn composer-primary"
      :class="{ 'stop-btn': stopsResponse, 'send-btn': !stopsResponse, listening: phase === 'listening', working: phase === 'connecting' || phase === 'stopping' }"
      :variant="!stopsResponse && (canSend || recording) ? 'primary' : 'secondary'"
      :disabled="disabled"
      :aria-label="label"
      :title="title"
      :aria-pressed="recording"
      :aria-busy="phase === 'connecting' || phase === 'stopping'"
      @pointerdown="pointerdown"
      @pointermove="pointermove"
      @pointerup="pointerup"
      @pointercancel="cancelPress"
      @lostpointercapture="cancelPress"
      @contextmenu.prevent
      @click="click"
    >
      <svg v-if="stopsResponse" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
      <svg v-else-if="(!recording && canSend) || (recording && locked)" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7z" /></svg>
      <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
      <span v-if="phase === 'listening'" class="voice-dot" aria-hidden="true" />
    </UiButton>
  </div>
</template>

<style scoped>
.send-voice-control { position: relative; flex: 0 0 auto; display: flex; align-items: center; gap: 0.375rem; }
.voice-btn { position: relative; touch-action: none; user-select: none; -webkit-touch-callout: none; }
.voice-btn svg { display: block; }
.voice-dot { position: absolute; top: 4px; right: 4px; width: 5px; height: 5px; border-radius: 50%; background: var(--bg-danger); animation: voice-blink 1.2s steps(1) infinite; }
.voice-gesture-hint { pointer-events: none; position: absolute; bottom: calc(100% + 0.5rem); right: 0; z-index: 10; display: flex; align-items: center; gap: 0.375rem; width: max-content; max-width: min(240px, calc(100vw - 32px)); padding: 0.375rem 0.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-sidebar); color: var(--text-primary); font-size: 0.75rem; line-height: 1.4; }
@keyframes voice-blink { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .voice-dot { animation: none; } }
</style>
