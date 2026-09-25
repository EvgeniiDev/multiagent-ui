<script setup lang="ts">
// Mic button for the composer: streams microphone audio to the host's STT
// service (lib/stt.ts) as 100 ms PCM16 @16 kHz frames and forwards the
// transcript events to ChatView, which owns the textarea.
//
// Failure modes are surfaced, never silent: service unreachable -> the
// button stays disabled with the reason on its title; mic denied or a
// dropped socket -> `error` is emitted so the composer shows a line, and
// the text already recognised stays in the field.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { sttHealth, StreamingStt, type SttPartial } from '../lib/stt';

const props = defineProps<{
  /** Composer busy (a turn is running / reconnecting) — matches the other
   *  row buttons. */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /** phase transition or elapsed-second tick */
  state: [{ phase: VoicePhase; elapsedS: number }];
  /** interim transcript: committed is settled text, volatile may change */
  partial: [p: SttPartial];
  /** final text to keep in the field (also used to commit the last
   *  hypothesis when the socket drops mid-recording) */
  final: [text: string];
  /** visible, human-readable failure */
  error: [message: string];
}>();

type VoicePhase = 'idle' | 'connecting' | 'listening' | 'stopping';

const phase = ref<VoicePhase>('idle');
const elapsedS = ref(0);
const serviceDown = ref(false);
const micUnavailable = ref(false);

// Re-probe a dead service every so often so the button recovers on its own.
const REPROBE_MS = 15000;
const FINAL_WAIT_MS = 9000; // the server re-decodes the whole utterance once

let reprobeTimer: ReturnType<typeof setInterval> | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let finalTimer: ReturnType<typeof setTimeout> | null = null;
let stt: StreamingStt | null = null;
let lastPartial: SttPartial = { committed: '', volatile: '' };
// A click during `connecting` aborts: pending awaits check this generation
// before committing their resources so a cancelled attempt can't linger.
let sessionGen = 0;

// --- audio pipeline (created per session, torn down on stop) -------------
let mediaStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let audioSrc: MediaStreamAudioSourceNode | null = null;
let audioNode: ScriptProcessorNode | null = null;
let pending: number[] = [];
let resample: ((input: Float32Array) => Float32Array) | null = null;

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz — the cadence the server expects

/** Linear resampler inRate -> 16 kHz with carry across callbacks. A plain
 *  decimator would alias; interpolation keeps speech intelligible for STT
 *  and costs nothing at these rates. */
function makeResampler(inRate: number): (input: Float32Array) => Float32Array {
  const ratio = inRate / TARGET_RATE;
  if (ratio === 1) return (input) => input;
  let carry = new Float32Array(0);
  let pos = 0;
  return (input) => {
    const data = new Float32Array(carry.length + input.length);
    data.set(carry);
    data.set(input, carry.length);
    const outLen = Math.floor((data.length - 1 - pos) / ratio);
    if (outLen <= 0) {
      carry = data;
      return new Float32Array(0);
    }
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = pos + i * ratio;
      const i0 = Math.floor(p);
      const frac = p - i0;
      out[i] = data[i0] * (1 - frac) + data[i0 + 1] * frac;
    }
    pos += outLen * ratio;
    const consumed = Math.floor(pos);
    carry = data.slice(consumed);
    pos -= consumed;
    return out;
  };
}

function feedPcm(input: Float32Array): void {
  if (!resample || !stt) return;
  const resampled = resample(input);
  for (let i = 0; i < resampled.length; i++) pending.push(resampled[i]);
  while (pending.length >= CHUNK_SAMPLES) {
    const chunk = pending.splice(0, CHUNK_SAMPLES);
    stt.push(floatToPcm16(chunk));
  }
}

function floatToPcm16(samples: number[] | Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

/** Flush the sub-100 ms tail so the final pass hears the whole utterance. */
function flushPending(): void {
  if (!stt || pending.length === 0) return;
  const tail = pending;
  pending = [];
  stt.push(floatToPcm16(tail));
}

function teardownAudio(): void {
  if (audioNode) {
    audioNode.onaudioprocess = null;
    try {
      audioNode.disconnect();
    } catch {
      /* already disconnected */
    }
    audioNode = null;
  }
  if (audioSrc) {
    try {
      audioSrc.disconnect();
    } catch {
      /* ignore */
    }
    audioSrc = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  resample = null;
  pending = [];
}

function teardownStt(): void {
  if (finalTimer) {
    clearTimeout(finalTimer);
    finalTimer = null;
  }
  if (stt) {
    stt.close();
    stt = null;
  }
}

function setPhase(next: VoicePhase): void {
  phase.value = next;
  emit('state', { phase: next, elapsedS: elapsedS.value });
}

function stopElapsed(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  elapsedS.value = 0;
}

function endSession(): void {
  teardownAudio();
  teardownStt();
  stopElapsed();
  setPhase('idle');
}

/** Commit the last hypothesis so a dropped socket still keeps the text the
 *  user watched being recognised. */
function commitLast(): string {
  return (lastPartial.committed + ' ' + lastPartial.volatile).trim();
}

function fail(message: string): void {
  endSession();
  if (message) emit('error', message);
}

async function startListening(): Promise<void> {
  const gen = ++sessionGen;
  lastPartial = { committed: '', volatile: '' };
  setPhase('connecting');

  if (!navigator.mediaDevices?.getUserMedia) {
    fail('Voice input needs a secure context (localhost or HTTPS)');
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    fail(
      name === 'NotFoundError' || name === 'DevicesNotFoundError'
        ? 'No microphone found'
        : 'Microphone access denied — check browser permissions',
    );
    return;
  }
  if (gen !== sessionGen) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  mediaStream = stream;

  const session = new StreamingStt({
    onPartial: (p) => {
      lastPartial = p;
      emit('partial', p);
    },
    onFinal: (text) => {
      endSession();
      emit('final', text.trim());
    },
    onError: (message) => emit('error', message),
    onClose: (hadFinal) => {
      // Clean finish after `stop()` is handled by onFinal; anything else is
      // a drop — keep the last hypothesis in the field and say what broke.
      if (phase.value === 'idle' || hadFinal) return;
      const last = commitLast();
      endSession();
      emit('final', last);
      emit('error', 'Speech service connection lost — kept recognised text');
    },
  });
  stt = session;
  try {
    await session.open();
  } catch {
    if (gen === sessionGen) fail('Speech service unreachable — websocket refused');
    else teardownStt();
    return;
  }
  if (gen !== sessionGen) {
    endSession();
    return;
  }

  try {
    // Prefer a 16 kHz context so most builds skip resampling entirely; where
    // the option is ignored the JS resampler below covers the gap.
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext unavailable');
    audioCtx = new Ctor({ sampleRate: TARGET_RATE } as AudioContextOptions);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (gen !== sessionGen) {
      endSession();
      return;
    }
    resample = makeResampler(audioCtx.sampleRate);
    audioSrc = audioCtx.createMediaStreamSource(mediaStream);
    audioNode = audioCtx.createScriptProcessor(4096, 1, 1);
    // The ScriptProcessor only runs while connected; nothing is written to
    // its output buffer, so the mic is not echoed to the speakers.
    audioNode.onaudioprocess = (ev) => {
      feedPcm(ev.inputBuffer.getChannelData(0));
    };
    audioSrc.connect(audioNode);
    audioNode.connect(audioCtx.destination);
  } catch {
    fail('Could not start audio capture');
    return;
  }

  elapsedS.value = 0;
  elapsedTimer = setInterval(() => {
    elapsedS.value += 1;
    emit('state', { phase: phase.value, elapsedS: elapsedS.value });
  }, 1000);
  setPhase('listening');
}

function stopListening(): void {
  if (phase.value === 'connecting') {
    sessionGen += 1; // pending startListening awaits bail out
    endSession();
    return;
  }
  if (phase.value !== 'listening') return;
  setPhase('stopping');
  flushPending();
  stt?.stop();
  teardownAudio(); // mic off immediately — the "recording" affordance is honest
  stopElapsed();
  // The server re-decodes the whole utterance; give it room, then treat a
  // missing answer as a drop (onClose normally fires when the socket ends).
  finalTimer = setTimeout(() => {
    if (phase.value === 'stopping') {
      const last = commitLast();
      teardownStt();
      setPhase('idle');
      emit('final', last);
      emit('error', 'Speech service did not send a final — kept recognised text');
    }
  }, FINAL_WAIT_MS);
}

const buttonDisabled = computed(() => {
  if (phase.value === 'listening') return false; // stop must stay reachable
  if (phase.value !== 'idle') return true;
  return !!(props.disabled || serviceDown.value || micUnavailable.value);
});

const buttonTitle = computed(() => {
  if (micUnavailable.value)
    return 'Voice input needs a secure context (localhost or HTTPS)';
  if (serviceDown.value)
    return 'Voice input unavailable — speech service not reachable';
  switch (phase.value) {
    case 'connecting':
      return 'Starting microphone…';
    case 'listening':
      return 'Stop dictation (Esc)';
    case 'stopping':
      return 'Finishing…';
    default:
      return 'Dictate';
  }
});

/** Live transcript for the take: committed + still-moving hypothesis.
 *  Empty while the first partial is in flight — the caller shows the
 *  `listeningHint` instead of guessing.
 *  // ponytail: derived accessor, no tests of its own — covered by e2e_voice overlay asserts. */

function onClick(): void {
  if (phase.value === 'listening') {
    stopListening();
    return;
  }
  if (phase.value !== 'idle' || buttonDisabled.value) return;
  void startListening();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && phase.value !== 'idle') {
    ev.preventDefault();
    stopListening();
  }
}

async function probe(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia) {
    micUnavailable.value = true;
    serviceDown.value = false;
    return;
  }
  micUnavailable.value = false;
  serviceDown.value = (await sttHealth()) === null;
}

onMounted(() => {
  void probe();
  reprobeTimer = setInterval(() => {
    if (serviceDown.value) void probe();
  }, REPROBE_MS);
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  sessionGen += 1;
  if (reprobeTimer) clearInterval(reprobeTimer);
  window.removeEventListener('keydown', onKeydown);
  teardownAudio();
  teardownStt();
  stopElapsed();
});

defineExpose({ stop: stopListening });
</script>

<template>
  <button
    type="button"
    class="voice-btn"
    :class="{
      listening: phase === 'listening',
      working: phase === 'connecting' || phase === 'stopping',
    }"
    :disabled="buttonDisabled"
    :title="buttonTitle"
    :aria-label="buttonTitle"
    :aria-pressed="phase === 'listening'"
    @click="onClick"
  >
    <svg
      v-if="phase !== 'listening'"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
    <svg
      v-else
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
    <span v-if="phase === 'listening'" class="voice-dot" aria-hidden="true"></span>
  </button>
</template>

<style scoped>
/* Same square geometry as the composer's icon buttons (see .icon-btn in
 * ChatView.vue): 34px stroke-icon hit area, radius-md, no shadow — kept as
 * its own class so the button does not change the row's icon-btn count the
 * existing composer suite asserts. */
.voice-btn {
  position: relative;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  box-shadow: none;
  cursor: pointer;
}

.voice-btn svg {
  display: block;
}

.voice-btn:hover:not(:disabled) {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.voice-btn:focus-visible {
  outline: 2px solid var(--text-accent, #b04a28);
  outline-offset: 2px;
}

.voice-btn:disabled {
  color: var(--text-muted, #786d62);
  cursor: not-allowed;
}

/* Listening: the quiet accent tint the attach button uses for "active",
 * a stop square, and a live dot in the corner. */
.voice-btn.listening {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  color: var(--text-accent, #b04a28);
}

.voice-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-accent, #b04a28);
  animation: voice-blink 1.2s steps(1) infinite;
}

@keyframes voice-blink {
  50% {
    opacity: 0.25;
  }
}

@media (prefers-reduced-motion: reduce) {
  .voice-dot {
    animation: none;
  }
}

@media (max-width: 800px) {
  .voice-btn {
    width: 44px;
    height: 44px;
  }
}
</style>
