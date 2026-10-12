// Browser client for the audio-video-to-text OpenAI-compatible transcription API.
// Captured mono PCM16 @16 kHz is kept in memory and submitted as a WAV once
// dictation ends. The API is synchronous, so no partial transcript is available.

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

/** Collects PCM16 chunks and submits one WAV when the user stops recording. */
export class StreamingStt {
  private chunks: Int16Array[] = [];
  private started = false;
  private stopping = false;
  private gotFinal = false;
  private closedEmitted = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private stopPromise: Promise<void> | null = null;

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
    if (!this.isOpen || pcm.length === 0) return;
    this.chunks.push(new Int16Array(pcm));
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.isOpen) return Promise.resolve();
    this.stopping = true;
    this.started = false;
    this.stopPromise = this.transcribe();
    return this.stopPromise;
  }

  reset(): void {
    if (!this.isOpen) return;
    this.chunks = [];
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.controller?.abort();
    this.chunks = [];
    this.emitClose();
  }

  private async transcribe(): Promise<void> {
    try {
      const form = new FormData();
      form.append('file', new Blob([encodeWav(this.chunks)], { type: 'audio/wav' }), 'recording.wav');
      form.append('model', 'gigaam-v3');
      form.append('language', 'ru');
      form.append('response_format', 'text');
      this.chunks = [];
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort(), STT_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
          method: 'POST',
          body: form,
          signal: this.controller.signal,
        });
        if (!response.ok) {
          const detail = (await response.text()).trim();
          throw new Error(`Transcription API returned ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        const text = (await response.text()).trim();
        if (this.disposed) return;
        this.gotFinal = true;
        try {
          this.handlers.onFinal?.(text);
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'unknown callback error';
          this.handlers.onError?.(`Transcript handler failed: ${detail}`);
        }
      } finally {
        clearTimeout(timer);
        this.controller = null;
      }
    } catch (error) {
      if (!this.disposed) {
        const message = error instanceof Error && error.name === 'AbortError'
          ? 'Transcription API timed out'
          : error instanceof Error ? error.message : 'Transcription API request failed';
        this.handlers.onError?.(message);
      }
    } finally {
      this.emitClose();
    }
  }

  private emitClose(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.handlers.onClose?.(this.gotFinal);
  }
}
