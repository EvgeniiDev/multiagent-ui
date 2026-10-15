// Browser client for the audio-video-to-text OpenAI-compatible transcription API.
// Mono PCM16 @16 kHz is split into disjoint utterances at pauses. Finalized
// phrases are decoded once; replaceable previews cover only the current phrase.

export const STT_PORT = 8099;
/** HTTPS-front listener on 25906 now proxies to the transcription API on :8099. */
export const STT_TLS_PORT = 25906;
export const STT_HEALTH_TIMEOUT_MS = 1500;
export const STT_REQUEST_TIMEOUT_MS = 300_000;

export interface SttHealth {
  ok: boolean;
  verified: boolean;
}

export interface SttPartial {
  committed: string;
  volatile: string;
}

export interface SttHandlers {
  onPartial?: (p: SttPartial) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onClose?: (hadFinal: boolean) => void;
}

function sttBase(): string {
  const env = import.meta.env?.VITE_STT_URL as string | undefined;
  if (env) return env.replace(/\/+$/, '');
  const hostname =
    (typeof location !== 'undefined' && location.hostname) || '127.0.0.1';
  const secure =
    typeof location !== 'undefined' && location.protocol === 'https:';
  return secure
    ? `https://${hostname}:${STT_TLS_PORT}`
    : `http://${hostname}:${STT_PORT}`;
}

export function sttTranscriptionUrl(): string {
  return `${sttBase()}/v1/audio/transcriptions`;
}

/** Session-scoped guard against duplicate final/error callbacks from races. */
export function createVoiceEvents(
  onFinal: (text: string) => void,
  onError: (message: string) => void,
) {
  let finalSent = false;
  let errorSent = false;
  return {
    reset(): void {
      finalSent = false;
      errorSent = false;
    },
    final(text: string): boolean {
      if (finalSent) return false;
      finalSent = true;
      onFinal(text);
      return true;
    },
    error(message: string): boolean {
      if (errorSent) return false;
      errorSent = true;
      onError(message);
      return true;
    },
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<{ response: Response; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const response = await fetch(url, { ...init, signal: ctrl.signal });
    if (!response.ok) return { response, body: null };
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (ctrl.signal.aborted) throw error;
      body = null;
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe for the OpenAI-compatible transcription operation. */
export async function sttHealth(): Promise<SttHealth | null> {
  const url = `${sttBase()}/openapi.json`;
  try {
    const { response: res, body: rawBody } = await fetchJsonWithTimeout(url, {}, STT_HEALTH_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = rawBody as {
      paths?: Record<string, { post?: unknown }>;
    } | null;
    if (!body?.paths?.['/v1/audio/transcriptions']?.post) return null;
    return { ok: true, verified: true };
  } catch {
    // The direct HTTP endpoint has no CORS headers; an opaque response still
    // distinguishes a listening API from a refused connection on plain HTTP.
    try {
      await fetchWithTimeout(url, { mode: 'no-cors' }, STT_HEALTH_TIMEOUT_MS);
      return { ok: true, verified: false };
    } catch {
      return null;
    }
  }
}

function encodeWav(chunks: Int16Array[]): ArrayBuffer {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }
  return buffer;
}

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms; independent of audio callback boundaries
const PAUSE_FRAMES = 40; // 800 ms
const PAD_FRAMES = 10; // 200 ms of context before/after speech
const MAX_SAMPLES = 20 * SAMPLE_RATE;
const PREVIEW_SAMPLES = 3 * SAMPLE_RATE;
const MAX_BACKLOG_SAMPLES = 10 * 60 * SAMPLE_RATE;

type Utterance = { id: number; chunks: Int16Array[] };
type DecodeTask = Utterance & { final: boolean; epoch: number };

/** Audio partitions, never overlapping rolling windows or text-prefix guesses. */
class PcmUtterances {
  id = 0;
  private frame = new Int16Array(FRAME_SAMPLES);
  private used = 0;
  private leading: Int16Array[] = [];
  private active: Int16Array[] = [];
  private samples = 0;
  private silentFrames = 0;
  private previewAt = PREVIEW_SAMPLES;

  constructor(
    private complete: (phrase: Utterance) => void,
    private preview: (phrase: Utterance) => void,
  ) {}

  push(pcm: Int16Array): void {
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(FRAME_SAMPLES - this.used, pcm.length - offset);
      this.frame.set(pcm.subarray(offset, offset + take), this.used);
      this.used += take;
      offset += take;
      if (this.used === FRAME_SAMPLES) {
        this.consume(this.frame);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.used = 0;
      }
    }
  }

  finish(): void {
    if (this.used) this.consume(this.frame.slice(0, this.used));
    this.used = 0;
    this.seal();
  }

  private consume(frame: Int16Array): void {
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const voiced = energy > 200 * 200 * frame.length;
    if (!this.active.length && !voiced) {
      this.leading.push(frame);
      if (this.leading.length > PAD_FRAMES) this.leading.shift();
      return;
    }
    if (!this.active.length) {
      this.active = this.leading;
      this.leading = [];
      this.samples = this.active.reduce((n, block) => n + block.length, 0);
    }
    this.active.push(frame);
    this.samples += frame.length;
    this.silentFrames = voiced ? 0 : this.silentFrames + 1;
    if (this.silentFrames >= PAUSE_FRAMES) {
      this.active.splice(this.active.length - this.silentFrames + PAD_FRAMES);
      this.seal();
    } else if (this.samples >= MAX_SAMPLES) {
      this.seal();
    } else if (this.samples >= this.previewAt) {
      this.previewAt = this.samples + PREVIEW_SAMPLES;
      this.preview({ id: this.id, chunks: this.active.slice() });
    }
  }

  private seal(): void {
    if (!this.active.length) return;
    this.complete({ id: this.id++, chunks: this.active });
    this.active = [];
    this.samples = 0;
    this.silentFrames = 0;
    this.previewAt = PREVIEW_SAMPLES;
  }
}

/** One serial decoder: ordered final phrases + one coalesced live hypothesis. */
export class StreamingStt {
  private started = false;
  private stopping = false;
  private gotFinal = false;
  private closedEmitted = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private epoch = 0;
  private committed: string[] = [];
  private volatile = '';
  private queued: DecodeTask[] = [];
  private queuedSamples = 0;
  private inFlight: DecodeTask | null = null;
  private preview: DecodeTask | null = null;
  private draining = false;
  private audio = this.createAudio();

  constructor(
    private readonly handlers: SttHandlers,
    private readonly baseUrl: string = sttBase(),
  ) {}

  get isOpen(): boolean {
    return this.started && !this.stopping && !this.disposed && !this.closedEmitted;
  }

  async open(): Promise<void> {
    if (this.disposed) throw new Error('STT session is closed');
    this.started = true;
  }

  push(pcm: Int16Array): void {
    if (this.isOpen && pcm.length) this.audio.push(pcm);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.isOpen) return Promise.resolve();
    this.stopPromise = new Promise(resolve => { this.resolveStop = resolve; });
    this.stopping = true;
    this.started = false;
    this.audio.finish();
    this.preview = null;
    void this.drain();
    return this.stopPromise;
  }

  reset(): void {
    if (!this.isOpen) return;
    this.epoch++;
    this.controller?.abort();
    this.queued = [];
    this.queuedSamples = 0;
    this.preview = null;
    this.committed = [];
    this.volatile = '';
    this.audio = this.createAudio();
    this.publishPartial();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.controller?.abort();
    this.queued = [];
    this.queuedSamples = 0;
    this.preview = null;
    this.audio = this.createAudio();
    this.emitClose();
  }

  private createAudio(): PcmUtterances {
    return new PcmUtterances(
      phrase => {
        if (this.disposed) return;
        const samples = phrase.chunks.reduce((n, block) => n + block.length, 0);
        if (this.queuedSamples + samples > MAX_BACKLOG_SAMPLES) {
          this.handlers.onError?.('Speech recognition fell too far behind. Recording stopped; only the text recognized so far was kept.');
          this.close();
          return;
        }
        this.queuedSamples += samples;
        if (this.inFlight && !this.inFlight.final && this.inFlight.id === phrase.id) this.controller?.abort();
        this.queued.push({ ...phrase, final: true, epoch: this.epoch });
        this.preview = null;
        void this.drain();
      },
      phrase => {
        if (this.disposed) return;
        this.preview = { ...phrase, final: false, epoch: this.epoch };
        void this.drain();
      },
    );
  }

  private publishPartial(): void {
    try {
      this.handlers.onPartial?.({ committed: this.committed.join(' '), volatile: this.volatile });
    } catch {
      this.handlers.onError?.('Transcript handler failed while updating live text');
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (!this.disposed) {
        const task = this.queued.shift() ?? this.preview;
        if (!task) break;
        if (!task.final) this.preview = null;
        else this.queuedSamples -= task.chunks.reduce((n, block) => n + block.length, 0);
        this.inFlight = task;
        let text: string;
        try {
          text = await this.transcribe(task.chunks);
        } catch (error) {
          if (this.disposed || task.epoch !== this.epoch) continue;
          // A preview is disposable; a failed final must not silently omit audio.
          if (!task.final) continue;
          const message = error instanceof Error && error.name === 'AbortError'
            ? 'Transcription API timed out'
            : error instanceof Error ? error.message : 'Transcription API request failed';
          this.handlers.onError?.(message);
          this.close();
          return;
        }
        if (this.disposed || task.epoch !== this.epoch) continue;
        if (task.final) {
          if (text) this.committed.push(text);
          this.volatile = '';
          this.publishPartial();
        } else if (!this.stopping && task.id === this.audio.id) {
          this.volatile = text;
          this.publishPartial();
        }
      }
      if (this.stopping && !this.disposed) {
        this.gotFinal = true;
        try {
          this.handlers.onFinal?.(this.committed.join(' '));
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'unknown callback error';
          this.handlers.onError?.(`Transcript handler failed: ${detail}`);
        }
        this.emitClose();
      }
    } finally {
      this.inFlight = null;
      this.draining = false;
    }
  }

  private async transcribe(chunks: Int16Array[]): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([encodeWav(chunks)], { type: 'audio/wav' }), 'recording.wav');
    form.append('model', 'gigaam-v3');
    form.append('language', 'ru');
    form.append('response_format', 'text');
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), STT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
        method: 'POST', body: form, signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(`Transcription API returned ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return (await response.text()).trim();
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  private emitClose(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.resolveStop?.();
    this.handlers.onClose?.(this.gotFinal);
  }
}
