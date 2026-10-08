// Streaming speech-to-text client for the composer mic button.
//
// The service (server/stt-server.py, Compose stt service) lives on
// the same host as the panel and talks raw PCM16 mono @16 kHz:
//   GET  http://<hostname>:25905/health   -> {ok, model, loaded, sample_rate}
//   WS   ws://<hostname>:25905/ws/stream  <- binary PCM16 frames (~100 ms)
//                                        -> {"type":"partial","committed","volatile",...}
//                                           {"type":"final","text",...}
//                                           {"type":"error","error"}
//   text {"type":"stop"} asks for the final pass, {"type":"reset"} clears it.
//
// The health probe mirrors the state-server probe in lib/host/storage.ts:
// one short-timeout fetch decides availability. Because stt-server.py does
// not set CORS headers, a plain fetch from a web (cross-origin) page is
// rejected by the browser even when the service is healthy — so on a failed
// CORS fetch we retry with mode:'no-cors': it resolves iff *something* HTTP
// answers on the port, which is the availability signal the UI needs. The
// WebSocket itself is not subject to CORS and streams regardless.

export const STT_PORT = 25905;
/** Port of the TLS front that proxies the STT service (see server/https-front.mjs). */
export const STT_TLS_PORT = 25906;
export const STT_HEALTH_TIMEOUT_MS = 1500;
export const STT_WS_OPEN_TIMEOUT_MS = 4000;

export interface SttHealth {
  ok: boolean;
  model?: string;
  loaded?: boolean;
  sampleRate?: number;
  /** false when only the opaque no-cors probe succeeded — the port answers
   *  HTTP but the body could not be verified (missing CORS headers). */
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
  /** Fires exactly once when the socket closes — expected (after a final)
   *  or not. `hadFinal` lets the UI tell a clean finish from a mid-stream
   *  drop. */
  onClose?: (hadFinal: boolean) => void;
}

// `VITE_STT_URL` overrides the whole base URL at build time (tests,
// non-standard deployments); default is the host that served this bundle.
/**
 * Base URL of the service. An https page must talk to the TLS front (25906):
 * plain http on 25905 would be blocked as mixed content, and the mic button
 * would look broken on the very deployment that makes voice possible.
 */
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

export function sttWsUrl(): string {
  const env = import.meta.env?.VITE_STT_URL as string | undefined;
  if (env) {
    return `${env.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/stream`;
  }
  const hostname =
    (typeof location !== 'undefined' && location.hostname) || '127.0.0.1';
  const secure =
    typeof location !== 'undefined' && location.protocol === 'https:';
  const scheme = secure ? 'wss' : 'ws';
  const port = secure ? STT_TLS_PORT : STT_PORT;
  return `${scheme}://${hostname}:${port}/ws/stream`;
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

/** Probe the service once. Resolves null when nothing answers the port. */
export async function sttHealth(): Promise<SttHealth | null> {
  const url = `${sttBase()}/health`;
  try {
    const res = await fetchWithTimeout(url, {}, STT_HEALTH_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      model?: string;
      loaded?: boolean;
      sample_rate?: number;
    } | null;
    if (!body || body.ok !== true) return null;
    return {
      ok: true,
      model: body.model,
      loaded: body.loaded,
      sampleRate: body.sample_rate,
      verified: true,
    };
  } catch {
    // CORS-blocked or connection refused — disambiguate with an opaque probe.
    try {
      await fetchWithTimeout(url, { mode: 'no-cors' }, STT_HEALTH_TIMEOUT_MS);
      return { ok: true, verified: false };
    } catch {
      return null;
    }
  }
}

/**
 * One streaming session over /ws/stream. `push()` accepts 16 kHz mono PCM16
 * frames (Int16Array; ~100 ms each — the server tolerates other sizes but
 * partial cadence is calibrated to that chunking).
 */
export class StreamingStt {
  private ws: WebSocket | null = null;
  private gotFinal = false;
  private closedEmitted = false;
  private disposed = false;

  constructor(
    private readonly handlers: SttHandlers,
    private readonly url: string = sttWsUrl(),
  ) {}

  get isOpen(): boolean {
    return !this.disposed && !this.gotFinal && !this.closedEmitted && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves once the socket is OPEN; rejects on timeout/refusal. */
  open(): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('message', (ev) => this.handleMessage(ev));
    ws.addEventListener('close', () => this.emitClose());
    // The browser always fires `close` after `error`; nothing to forward.

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          reject(new Error(`STT websocket timed out after ${STT_WS_OPEN_TIMEOUT_MS}ms`));
        });
      }, STT_WS_OPEN_TIMEOUT_MS);
      ws.addEventListener('open', () => settle(resolve));
      ws.addEventListener('error', () =>
        settle(() => reject(new Error('STT websocket connect failed'))),
      );
      ws.addEventListener('close', () =>
        settle(() => reject(new Error('STT websocket closed before open'))),
      );
    });
  }

  /** Queue one PCM16 chunk. No-op unless the socket is open. */
  push(pcm: Int16Array): void {
    if (!this.isOpen) return;
    try {
      this.ws!.send(pcm);
    } catch {
      /* socket died between check and send; close event reports it */
    }
  }

  /** Ask for the final pass. The server answers {"type":"final"} then closes. */
  stop(): void {
    if (!this.isOpen) return;
    try {
      this.ws!.send(JSON.stringify({ type: 'stop' }));
    } catch {
      /* close event reports the failure */
    }
  }

  /** Drop the buffered utterance on the server side (socket stays open). */
  reset(): void {
    if (!this.isOpen) return;
    try {
      this.ws!.send(JSON.stringify({ type: 'reset' }));
    } catch {
      /* ignore */
    }
  }

  /** Idempotent teardown — safe to call from any state. */
  close(): void {
    this.disposed = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      this.emitClose();
      return;
    }
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    // If the browser elides the close event (already CLOSING/CLOSED), make
    // sure listeners still see exactly one onClose.
    queueMicrotask(() => this.emitClose());
  }

  private handleMessage(ev: MessageEvent): void {
    if (this.disposed || this.gotFinal || this.closedEmitted) return;
    if (typeof ev.data !== 'string') return; // server sends JSON text only
    let msg: { type?: string; committed?: string; volatile?: string; text?: string; error?: string };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'partial') {
      this.handlers.onPartial?.({
        committed: msg.committed ?? '',
        volatile: msg.volatile ?? '',
      });
    } else if (msg.type === 'final') {
      this.gotFinal = true;
      this.handlers.onFinal?.(msg.text ?? '');
    } else if (msg.type === 'error') {
      this.handlers.onError?.(msg.error || 'STT service error');
    }
  }

  private emitClose(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.handlers.onClose?.(this.gotFinal);
  }
}
