<script setup lang="ts">
// Mic button for the composer: streams mono PCM16 into pause-delimited WAVs.
// Finalized phrases stay stable; only the current phrase has a replaceable
// hypothesis. Stop drains the remaining phrases rather than re-decoding the take.
//
// Failure modes are surfaced, never silent: API unreachable -> the button stays
// disabled with the reason on its title; mic denial or a failed request emits
// `error` so the composer shows a line, while typed draft text stays untouched.
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import UiSendVoiceButton from './ui/UiSendVoiceButton.vue';
import { sttHealth, StreamingStt, createVoiceEvents, type SttPartial } from '../lib/stt';

const props = defineProps<{
  /** Composer busy (a turn is running / reconnecting) — matches the other
   *  row buttons. */
  disabled?: boolean;
  canSend: boolean;
  stopResponse: boolean;
  active: boolean;
}>();

const emit = defineEmits<{
  send: [];
  'stop-response': [];
  /** phase transition or elapsed-second tick */
  state: [{ phase: VoicePhase; elapsedS: number }];
  /** Ordered committed phrases plus the current replaceable hypothesis. */
  partial: [p: SttPartial];
  /** Aggregate transcript inserted once when recording has finished. */
  final: [text: string];
  /** visible, human-readable failure */
  error: [message: string];
}>();

const voiceEvents = createVoiceEvents(
  (text) => emit('final', text),
  (message) => emit('error', message),
);

type VoicePhase = 'idle' | 'connecting' | 'listening' | 'stopping';

const phase = ref<VoicePhase>('idle');
const elapsedS = ref(0);
const serviceDown = ref(false);
const micUnavailable = ref(false);

// Re-probe a dead service every so often so the button recovers on its own.
const REPROBE_MS = 15000;
const FINAL_WAIT_MS = 310_000; // API request is synchronous; allow up to 5 min

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
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz; segmenter handles pause boundaries

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
  setPhase('idle');
  teardownAudio();
  teardownStt();
  stopElapsed();
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
  voiceEvents.reset();
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
    if (gen !== sessionGen) return;
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
      if (gen !== sessionGen || stt !== session) return;
      lastPartial = p;
      emit('partial', p);
    },
    onFinal: (text) => {
      if (gen !== sessionGen || stt !== session) return;
      endSession();
      voiceEvents.final(text.trim());
    },
    onError: (message) => {
      if (gen === sessionGen && stt === session) {
        voiceEvents.error(message);
      }
    },
    onClose: (hadFinal) => {
      if (gen !== sessionGen || stt !== session) return;
      // A closed session without a final transcript is incomplete — retain the
      // composer draft and explain why the request ended.
      if (phase.value === 'idle' || hadFinal) return;
      const last = commitLast();
      endSession();
      voiceEvents.final(last);
      voiceEvents.error('Transcription ended before a final transcript was returned');
    },
  });
  stt = session;
  try {
    await session.open();
  } catch {
    if (gen === sessionGen) fail('Transcription API unreachable');
    else session.close();
    return;
  }
  if (gen !== sessionGen) {
    session.close();
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
      session.close();
      return;
    }
    resample = makeResampler(audioCtx.sampleRate);
    audioSrc = audioCtx.createMediaStreamSource(mediaStream);
    audioNode = audioCtx.createScriptProcessor(4096, 1, 1);
    // The ScriptProcessor only runs while connected; nothing is written to
    // its output buffer, so the mic is not echoed to the speakers.
    audioNode.onaudioprocess = (ev) => {
      if (gen !== sessionGen || stt !== session || phase.value !== 'listening') return;
      feedPcm(ev.inputBuffer.getChannelData(0));
    };
    audioSrc.connect(audioNode);
    audioNode.connect(audioCtx.destination);
  } catch {
    if (gen !== sessionGen) { session.close(); return; }
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
  const gen = sessionGen;
  setPhase('stopping');
  flushPending();
  stt?.stop();
  teardownAudio(); // mic off immediately — the "recording" affordance is honest
  stopElapsed();
  if (!stt) return; // all phrases may already be decoded and the session closed
  // Drain queued phrases and the final tail; the microphone is already off.
  finalTimer = setTimeout(() => {
    if (gen === sessionGen && phase.value === 'stopping') {
      const last = commitLast();
      setPhase('idle');
      teardownStt();
      voiceEvents.final(last);
      voiceEvents.error('Transcription timed out — kept the text recognized so far');
    }
  }, FINAL_WAIT_MS);
}

const voiceUnavailable = computed(() => micUnavailable.value
  ? 'Voice input needs a secure context (localhost or HTTPS)'
  : serviceDown.value ? 'Voice input unavailable — speech service not reachable' : '');
const buttonDisabled = computed(() => {
  if (phase.value === 'connecting' || phase.value === 'listening') return false;
  if (phase.value === 'stopping') return true;
  if (props.stopResponse) return false;
  return !!props.disabled || (!props.canSend && !!voiceUnavailable.value);
});
function record(): void {
  if (props.disabled || phase.value !== 'idle' || !props.active) return;
  if (voiceUnavailable.value) { emit('error', voiceUnavailable.value); return; }
  void startListening();
}
function cancelRecording(): void {
  sessionGen += 1;
  endSession();
  lastPartial = { committed: '', volatile: '' };
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

/** Wait for final/fallback text to reach ChatView before it snapshots a send. */
async function finish(): Promise<void> {
  if (phase.value === 'idle') return;
  await new Promise<void>((resolve) => {
    const unwatch = watch(phase, (value) => {
      if (value === 'idle') {
        unwatch();
        // Final text is emitted synchronously after the idle state.
        void nextTick(resolve);
      }
    });
    stopListening();
  });
}

defineExpose({ stop: stopListening, finish });
</script>

<template>
  <UiSendVoiceButton
    :phase="phase"
    :can-send="canSend"
    :stop-response="stopResponse"
    :active="active"
    :disabled="buttonDisabled"
    :voice-unavailable="voiceUnavailable"
    @record="record"
    @send="emit('send')"
    @stop-response="emit('stop-response')"
    @stop-recording="stopListening"
    @cancel-recording="cancelRecording"
  />
</template>
