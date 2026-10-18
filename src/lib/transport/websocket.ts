// WebSocket transport — connects directly to a remote ACP agent that
// natively speaks JSON-RPC over `ws://` / `wss://`.
//
// Design notes (see plan §6.2):
// - The browser WebSocket API cannot set arbitrary HTTP headers. To carry an
//   `Authorization` value we fold it into the WebSocket subprotocol list as
//   `bearer.<token>`. Servers that want to authenticate this way negotiate
//   the protocol back; servers that prefer cookies / query params will simply
//   ignore the extra subprotocol entries.
// - One inbound `MessageEvent` is assumed to carry exactly one JSON-RPC frame
//   (this matches every draft of the ACP Streamable HTTP / WebSocket RFD so
//   far). Binary frames are not part of the ACP wire format and are rejected.
// - `close()` is idempotent; the unhealthy-states (closing/closed) are mapped
//   to no-ops so callers don't have to track them themselves.
// - This transport intentionally does NOT auto-reconnect. The plan calls for
//   reconnect+backoff, but reconnecting silently can desync session state on
//   the agent side (sessions are per-connection in most ACP implementations).
//   We instead surface the close to the session store, which can present a
//   clear "reconnect" affordance to the user.
import { TransportListeners, type AcpTransport, type Unsubscribe } from './types';

const ACP_SUBPROTOCOL = 'acp.v1';

/**
 * Default heartbeat interval (ms). Many home NATs evict idle UDP/TCP
 * mappings around 60 s, devtunnel/free-tier reverse proxies typically use
 * ~60 s, and nginx defaults `proxy_read_timeout` to 60 s. We send a
 * JSON-RPC notification every 25 s so a tick always lands inside the
 * shortest common window even with a dropped one. Set to 0 to disable.
 */
const DEFAULT_HEARTBEAT_MS = 25_000;

/** Method name for the heartbeat ping. The `$/`-prefixed namespace follows
 * the LSP/JSON-RPC convention for implementation-defined notifications: a
 * conforming server that doesn't recognise the method MUST silently ignore
 * it (JSON-RPC 2.0 §4.1, "The Server MUST NOT reply to a Notification").
 * Bridges that implement the heartbeat answer it themselves with `$/pong`. */
const HEARTBEAT_METHOD = '$/ping';

/** Method name of the bridge's heartbeat reply — consumed below the bridge
 * layer so it never reaches the Traffic Monitor or the RPC idle timer. */
const HEARTBEAT_PONG_METHOD = '$/pong';

/**
 * Consecutive silent heartbeat intervals that convict a PONG-CAPABLE peer of
 * being half-open. At the 25 s default this detects in ~50 s; the bridge's
 * own protocol-ping sweep covers the same bound server-side.
 */
const MAX_MISSED_PONGS = 2;

// A fast LAN peer need not spend three seconds proving it disappeared.
// Keep room for jitter, and retain the caller's ceiling on slower networks.
const MIN_PROBE_TIMEOUT_MS = 500;
const PROBE_RTT_MULTIPLIER = 4;

/**
 * Pings sent without ANY inbound frame before we conclude the peer simply
 * never answers `$/ping` (native ACP-over-WS agent, or an old bridge) and
 * stop enforcing liveness — the ping stays keepalive-only, exactly as
 * before. Without this grace window the new accounting would tear down
 * healthy connections to agents that speak ACP natively.
 */
const PONG_GRACE_PINGS = 4;

/** Options accepted by `WebSocketTransport.connect`. */
export interface WebSocketTransportOptions {
  /** Full ws:// or wss:// URL to the agent endpoint. Required. */
  url: string;
  /**
   * Optional HTTP-style headers. Only `Authorization: Bearer <token>` is
   * meaningfully transmitted, encoded as a `bearer.<token>` subprotocol entry.
   * Other entries are recorded but ignored on the wire.
   */
  headers?: Record<string, string>;
  /** Additional application subprotocols, alongside ACP and bearer auth. */
  protocols?: string[];
  /**
   * Override the connection timeout (ms). Defaults to 15s; long enough for a
   * cold TLS handshake on slow mobile networks but short enough that users
   * notice a wedged endpoint.
   */
  connectTimeoutMs?: number;
  /**
   * Application-level heartbeat interval in milliseconds. Sends a `$/ping`
   * JSON-RPC notification on this cadence to keep idle NAT/proxy mappings
   * warm. Defaults to {@link DEFAULT_HEARTBEAT_MS}; set to `0` to disable.
   */
  heartbeatMs?: number;
  /**
   * Inject a constructor for testability. Defaults to the global
   * `WebSocket`. Tests pass a fake constructor here.
   */
  WebSocketCtor?: typeof WebSocket;
}

export class WebSocketTransport implements AcpTransport {
  private readonly messageListeners = new TransportListeners<string>();
  private readonly closeListeners = new TransportListeners<string | undefined>();
  private ws: WebSocket | null = null;
  private closed = false;
  /** Periodic heartbeat timer (see {@link DEFAULT_HEARTBEAT_MS}). */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether the peer provably answers `$/ping` with `$/pong`.
   * `null` until the first pong arrives or {@link PONG_GRACE_PINGS} pings go
   * unanswered → `false` and liveness enforcement stops entirely (the peer
   * is a native ACP-over-WS agent or an old bridge — keepalive only).
   */
  private pongCapable: boolean | null = null;
  /**
   * A ping went out and NO inbound frame has arrived since. Any inbound
   * line — not just `$/pong` — clears it: anything arriving proves the TCP
   * is alive, which is all the liveness accounting needs.
   */
  private awaitingPong = false;
  /** Consecutive heartbeat intervals with zero inbound frames. */
  private missedPongs = 0;
  private lastPing: { nonce: string; startedAt: number } | null = null;
  private recentPongRttMs: number | null = null;
  /** Dedupes concurrent probe() callers onto one in-flight ping. */
  private probePromise: Promise<boolean> | null = null;
  /** Resolver for the in-flight probe, called by any inbound frame. */
  private probeResolve: ((alive: boolean) => void) | null = null;

  private constructor(ws: WebSocket, heartbeatMs: number) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.handleMessage(ev));
    ws.addEventListener('close', (ev) =>
      this.handleClose(`websocket closed (code=${ev.code}, reason=${ev.reason || 'unknown'})`)
    );
    ws.addEventListener('error', () => {
      // The `close` event always fires after `error`, so we forward only
      // there to avoid double-emitting close to listeners.
    });
    if (heartbeatMs > 0) {
      this.startHeartbeat(heartbeatMs);
    }
  }

  /**
   * Connect a new WebSocket and resolve once it is OPEN.
   *
   * Rejects on connect timeout, on a `close` event before `open`, or on
   * `error` events that arrive before `open`.
   */
  static async connect(opts: WebSocketTransportOptions): Promise<WebSocketTransport> {
    const Ctor = opts.WebSocketCtor ?? globalThis.WebSocket;
    if (typeof Ctor !== 'function') {
      throw new Error('WebSocket is not available in this environment');
    }
    if (!opts.url) {
      throw new Error('WebSocketTransport requires a url');
    }

    const subprotocols = buildSubprotocols(opts.headers);
    const ws = new Ctor(opts.url, [...subprotocols, ...(opts.protocols || [])]);
    const timeoutMs = opts.connectTimeoutMs ?? 15000;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        settle(() => resolve());
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        settle(() => reject(new Error('WebSocket connect failed')));
      });
      ws.addEventListener('close', (ev) => {
        clearTimeout(timer);
        settle(() =>
          reject(
            new Error(
              `WebSocket closed before open (code=${ev.code}, reason=${ev.reason || 'unknown'})`
            )
          )
        );
      });
    });

    return new WebSocketTransport(ws, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  }

  private handleMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      // Frames may carry one or more newline-delimited JSON objects.
      // Stdio↔WS bridges (e.g. @rebornix/stdio-to-ws) forward the agent's
      // stdout chunks verbatim, which can contain multiple NDJSON lines in
      // a single WS message. Split here so each consumer sees exactly one
      // JSON-RPC frame, matching the stdio transport's behaviour.
      const data = ev.data;
      for (const line of data.indexOf('\n') === -1 ? [data] : data.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && this.noteInboundLine(trimmed)) {
          this.messageListeners.emit(trimmed);
        }
      }
    } else {
      // Binary frames are not part of ACP. Surface a clear error rather than
      // silently dropping data so misbehaving servers are easy to diagnose.
      console.error('WebSocketTransport received non-string frame; dropping', ev.data);
    }
  }

  /**
   * Liveness bookkeeping for one inbound NDJSON line. Any arriving line
   * proves the socket is alive: it clears the unanswered-ping flag and
   * resolves a pending `probe()` — it does not have to be a `$/pong`.
   *
   * A `$/pong` notification additionally marks the peer pong-capable and is
   * swallowed (returns false): heartbeats stay below the bridge layer, so
   * they must not appear in the Traffic Monitor nor feed `AcpClientBridge`'s
   * RPC idle timer.
   */
  private noteInboundLine(line: string): boolean {
    this.awaitingPong = false;
    this.missedPongs = 0;
    this.resolveProbe(true);
    if (!line.includes(HEARTBEAT_PONG_METHOD)) return true;
    try {
      const msg = JSON.parse(line);
      if (msg && typeof msg.method === 'string' && msg.method === HEARTBEAT_PONG_METHOD) {
        if (this.lastPing && msg.params?.nonce === this.lastPing.nonce) {
          const elapsed = performance.now() - this.lastPing.startedAt;
          this.recentPongRttMs = Math.max(elapsed, (this.recentPongRttMs ?? 0) * 0.8);
          this.lastPing = null;
        }
        this.pongCapable = true;
        return false;
      }
    } catch {
      /* not JSON — pass through like any other line */
    }
    return true;
  }

  private resolveProbe(alive: boolean): void {
    const r = this.probeResolve;
    this.probeResolve = null;
    try {
      r?.(alive);
    } catch {
      /* resolver never throws, but a listener bug must not break receive */
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.resolveProbe(false);
    this.closeListeners.emit(reason);
    this.messageListeners.clear();
    this.closeListeners.clear();
    this.ws = null;
  }

  private sendPing(): void {
    const nonce = Math.random().toString(36).slice(2);
    this.lastPing = { nonce, startedAt: performance.now() };
    this.awaitingPong = true;
    this.ws!.send(JSON.stringify({ jsonrpc: '2.0', method: HEARTBEAT_METHOD, params: { nonce } }) + '\n');
  }

  /**
   * Send a JSON-RPC `$/ping` notification on a fixed interval to keep the
   * connection alive across NAT / reverse-proxy idle timeouts. The frame is
   * sent below the bridge layer so it never appears in the Traffic Monitor.
   *
   * Heartbeats are notifications (no `id`) so a conforming agent never
   * replies; agents that don't recognise `$/ping` MUST silently ignore it
   * per JSON-RPC 2.0. We tolerate a transient send error (e.g. a race with
   * the server's own close) by stopping the timer rather than surfacing it.
   *
   * The same tick doubles as the client-side liveness check (browsers can't
   * send protocol pings): once the peer has proven it pongs, two
   * consecutive intervals with zero inbound frames mean a half-open socket
   * and we abort it ourselves — the OS may take minutes to report a dead
   * TCP on its own.
   */
  private startHeartbeat(intervalMs: number): void {
    const heartbeat = () => {
      if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      if (this.awaitingPong) {
        this.missedPongs += 1;
        if (this.pongCapable === null && this.missedPongs >= PONG_GRACE_PINGS) {
          // The peer has never answered a ping — almost certainly a native
          // ACP-over-WS agent or an old bridge where `$/ping` is keepalive
          // only. Mark it so liveness is never enforced against silence.
          this.pongCapable = false;
        }
        if (this.pongCapable === true && this.missedPongs >= MAX_MISSED_PONGS) {
          this.abortSocket(
            `no inbound frames for ${this.missedPongs} heartbeat intervals — socket is half-open`
          );
          return;
        }
      }
      try {
        this.sendPing();
      } catch (e) {
        console.warn('WebSocketTransport heartbeat send failed:', e);
        this.stopHeartbeat();
      }
    };
    this.heartbeatTimer = setInterval(heartbeat, intervalMs);
    heartbeat(); // establish pong capability/RTT before the first tab switch
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * The socket is half-open: the peer stopped answering but the TCP never
   * closed. `ws.close()` on such a socket can sit in CLOSING forever, so the
   * close event is synthesized immediately — that is what frees the session
   * runtime (a real `close` event, if it ever lands, hits the `closed`
   * guard in {@link handleClose}).
   */
  private abortSocket(reason: string): void {
    if (this.closed) return;
    this.stopHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.handleClose(reason);
  }

  /**
   * Prove the socket is alive within `timeoutMs`. Rides the heartbeat wire
   * format: sends a `$/ping` and resolves true on ANY inbound frame — a
   * `$/pong` or ordinary traffic either way proves the peer. Fast,
   * nonce-echoing peers use a measured RTT budget within that ceiling. On timeout,
   * a pong-capable peer is convicted (the socket is aborted, which drives
   * the normal close path); a never-ponged peer resolves with its socket
   * state — silence proves nothing there. Concurrent probes share one ping.
   */
  probe(timeoutMs: number): Promise<boolean> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    if (this.pongCapable === false) {
      // Best possible answer against a peer that cannot pong.
      return Promise.resolve(true);
    }
    if (this.probePromise) return this.probePromise;
    const budgetMs = this.pongCapable === true && this.recentPongRttMs !== null
      ? Math.min(timeoutMs, Math.max(MIN_PROBE_TIMEOUT_MS, Math.ceil(this.recentPongRttMs * PROBE_RTT_MULTIPLIER)))
      : timeoutMs;
    const ws = this.ws;
    this.probePromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.probeResolve = null;
        if (this.pongCapable === true) {
          this.abortSocket(`liveness probe timed out after ${budgetMs}ms`);
          resolve(false);
        } else {
          resolve(ws.readyState === WebSocket.OPEN);
        }
      }, budgetMs);
      this.probeResolve = (alive) => {
        clearTimeout(timer);
        resolve(alive);
      };
      try {
        this.sendPing();
      } catch {
        this.probeResolve = null;
        clearTimeout(timer);
        this.abortSocket('liveness probe send failed');
        resolve(false);
      }
    }).finally(() => {
      this.probePromise = null;
      this.probeResolve = null;
    });
    return this.probePromise;
  }

  async send(json: string): Promise<void> {
    if (this.closed || !this.ws) {
      throw new Error('WebSocketTransport is closed');
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `WebSocketTransport not open (readyState=${this.ws.readyState})`
      );
    }
    // Always terminate frames with '\n'. Native ACP-over-WS servers tolerate
    // trailing whitespace (JSON.parse / NDJSON readers ignore it), and stdio↔WS
    // bridges (e.g. @rebornix/stdio-to-ws) forward the WS payload verbatim to
    // the agent's stdin, which expects newline-delimited JSON. Without this
    // suffix the child blocks on `readline()` and we time out on `initialize`.
    const frame = json.endsWith('\n') ? json : json + '\n';
    this.ws.send(frame);
  }

  onMessage(cb: (json: string) => void): Unsubscribe {
    return this.messageListeners.add(cb);
  }

  onClose(cb: (reason?: string) => void): Unsubscribe {
    return this.closeListeners.add(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client closed');
      } catch (e) {
        console.warn('Error closing WebSocket:', e);
      }
    }
    // The browser will deliver a `close` event on a separate tick. If it
    // does, `handleClose` runs first and sets `this.closed = true`, in
    // which case our microtask below is a no-op. If, however, the close
    // event never fires (e.g. the WS was already in CLOSING/CLOSED state
    // and the browser elides the event), we synthesise a close so
    // listeners aren't left waiting forever.
    queueMicrotask(() => {
      if (!this.closed) {
        this.handleClose('closed by client');
      }
    });
  }
}

/**
 * Build the WebSocket subprotocol list from optional ACP/auth headers.
 *
 * Always advertises `acp.v1` as the canonical subprotocol so servers can
 * negotiate; folds an `Authorization: Bearer <token>` header into a
 * `bearer.<token>` entry so it survives the no-custom-headers limitation
 * of the browser WebSocket API.
 */
export function buildSubprotocols(
  headers?: Record<string, string>
): string[] {
  const protocols: string[] = [ACP_SUBPROTOCOL];
  if (!headers) return protocols;
  const auth = pickHeader(headers, 'authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) {
      // Subprotocol tokens cannot contain whitespace; the bearer token in
      // practice is base64-ish so this is safe, but we still strip just in
      // case to avoid handing the browser an invalid header value.
      const tok = m[1].replace(/\s+/g, '');
      protocols.push(`bearer.${tok}`);
    }
  }
  return protocols;
}

function pickHeader(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}
