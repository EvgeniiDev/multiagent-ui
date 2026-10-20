// ACP Client Bridge - Adapts a generic AcpTransport to the ACP SDK's
// Client interface. The bridge is transport-agnostic: it neither knows
// nor cares whether the underlying byte stream is a local subprocess
// (stdio), a WebSocket, or a Streamable HTTP connection.
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  AuthenticateRequest,
  AuthenticateResponse,
} from '@agentclientprotocol/sdk';
import { readTextFile as hostReadTextFile, writeTextFile as hostWriteTextFile } from './host';
import type { AcpTransport, Unsubscribe } from './transport/types';
import { createTransport } from './transport';
import type { AgentConfig, AgentInstance, PermissionRequest as LocalPermissionRequest } from './types';
import { hasLocalFs } from './platform';
import { ref, type Ref } from 'vue';
import { useTrafficStore } from '../stores/traffic';

// Event emitter for permission requests
type PermissionResolver = (response: RequestPermissionResponse) => void;

// Traffic store instance (lazily initialized)
let trafficStore: ReturnType<typeof useTrafficStore> | null = null;
function getTrafficStore() {
  if (!trafficStore) {
    trafficStore = useTrafficStore();
  }
  return trafficStore;
}

/** JSON-RPC method-not-found error code. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

/**
 * In-flight RPCs are abandoned only after the wire has been silent this long —
 * any frame in either direction is progress and re-arms the deadline, so a
 * long agent turn that keeps streaming `session/update`s is never cut (the old
 * fixed 60 s cap did exactly that). Mirrors the request watchdog in
 * `server/acp-ws-bridge.mjs`, which applies the same policy at the process
 * boundary and reports the failure as "no traffic for Ns". <= 0 disables.
 */
export let RPC_IDLE_TIMEOUT_MS = 180000;
export function setRpcIdleTimeoutMs(ms: number): void {
  RPC_IDLE_TIMEOUT_MS = ms;
}

export class AcpClientBridge implements Client {
  private transport: AcpTransport;
  /**
   * Local filesystem RPCs (`fs/read_text_file`, `fs/write_text_file`) are
   * handled by the Tauri fs plugin on desktop. On mobile and web builds the
   * plugin is not available and these handlers respond with a method-not-found
   * error so a misbehaving agent can't hang waiting for a response.
   */
  private fsAvailable: boolean;
  private messageResolvers: Map<number, (response: unknown) => void> = new Map();
  private messageRejecters: Map<number, (error: Error) => void> = new Map();
  private pendingMethods: Map<number, string> = new Map(); // Track method names for responses
  private nextRequestId = 0;
  private unlistenMessage: Unsubscribe | null = null;
  private unlistenClose: Unsubscribe | null = null;
  /** Idle deadline for in-flight requests (see RPC_IDLE_TIMEOUT_MS). */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Permission request handling
  public pendingPermissionRequest: Ref<LocalPermissionRequest | null> = ref(null);
  private permissionResolver: PermissionResolver | null = null;

  // Session update callback
  public onSessionUpdate: ((notification: SessionNotification) => void) | null = null;

  /** Optional callback for when the underlying transport closes unexpectedly. */
  public onTransportClose: ((reason?: string) => void) | null = null;

  constructor(transport: AcpTransport, options?: { fsAvailable?: boolean }) {
    this.transport = transport;
    // Default: fs is available iff we are on Tauri desktop. Callers (e.g.
    // remote agents that trust the host fs) can override.
    this.fsAvailable = options?.fsAvailable ?? hasLocalFs();
    this.unlistenMessage = this.transport.onMessage((msg) => this.handleMessage(msg));
    this.unlistenClose = this.transport.onClose((reason) => {
      // Reject all in-flight requests so callers stop hanging.
      this.clearIdleTimer();
      const err = new Error(`transport closed: ${reason ?? 'unknown reason'}`);
      for (const reject of this.messageRejecters.values()) {
        try {
          reject(err);
        } catch {
          /* ignore */
        }
      }
      this.messageResolvers.clear();
      this.messageRejecters.clear();
      this.pendingMethods.clear();
      if (this.onTransportClose) {
        this.onTransportClose(reason);
      }
    });
  }

  /**
   * Backwards-compatible no-op. Connection setup now happens in the factory
   * (`createAcpClient`) before the bridge is constructed.
   */
  async connect(): Promise<void> {
    // No-op: transport is already connected when handed to the bridge.
  }

  /**
   * Liveness check for verify-on-foreground: delegates to the transport's
   * probe when it has one (WebSocket ping/pong). Transports without a probe
   * — stdio pipes cannot half-open — report alive.
   */
  probe(timeoutMs: number): Promise<boolean> {
    return this.transport.probe?.(timeoutMs) ?? Promise.resolve(true);
  }

  async disconnect(): Promise<void> {
    // Unlisten first so the transport's close handler (which would re-reject
    // pending requests and fire `onTransportClose`) doesn't run for a
    // voluntary disconnect — `onTransportClose` is reserved for unexpected
    // closes. Then explicitly reject any in-flight requests here so callers
    // don't hang waiting for responses that will never arrive, and finally
    // close the transport.
    if (this.unlistenMessage) {
      this.unlistenMessage();
      this.unlistenMessage = null;
    }
    if (this.unlistenClose) {
      this.unlistenClose();
      this.unlistenClose = null;
    }
    this.clearIdleTimer();
    if (this.messageRejecters.size > 0) {
      const err = new Error('transport closed: client disconnected');
      for (const reject of this.messageRejecters.values()) {
        try {
          reject(err);
        } catch {
          /* ignore */
        }
      }
      this.messageResolvers.clear();
      this.messageRejecters.clear();
      this.pendingMethods.clear();
    }
    await this.transport.close();
  }

  /**
   * Any frame on the wire — request, response, or notification, inbound or
   * outbound — is progress: re-arm the idle deadline for the in-flight
   * requests. A request that is still producing traffic is never abandoned.
   */
  private noteTraffic(): void {
    if (this.messageResolvers.size === 0 || RPC_IDLE_TIMEOUT_MS <= 0) return;
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdleTimeout(), RPC_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * The wire has been silent for RPC_IDLE_TIMEOUT_MS with requests still
   * pending — a wedged agent, not a slow one (a live turn keeps the stream
   * busy). While the agent is waiting on US for a permission answer, silence
   * is expected: stand down and re-arm rather than failing the turn.
   */
  private onIdleTimeout(): void {
    this.idleTimer = null;
    if (this.permissionResolver) {
      this.armIdleTimer();
      return;
    }
    const secs = Math.round(RPC_IDLE_TIMEOUT_MS / 1000);
    const methods = [...this.pendingMethods.values()].join(', ') || 'unknown';
    const err = new Error(`no traffic for ${secs}s — RPC abandoned: ${methods}`);
    for (const reject of this.messageRejecters.values()) {
      try {
        reject(err);
      } catch {
        /* ignore */
      }
    }
    this.messageResolvers.clear();
    this.messageRejecters.clear();
    this.pendingMethods.clear();
  }

  private handleMessage(message: string): void {
    this.noteTraffic();
    try {
      const parsed = JSON.parse(message);
      const store = getTrafficStore();

      // Handle JSON-RPC response (has id and result/error, no method)
      if ('id' in parsed && parsed.id !== undefined && !('method' in parsed)) {
        // Track incoming response
        store.addEntry({
          direction: 'in',
          type: 'response',
          method: this.pendingMethods.get(parsed.id) || 'unknown',
          requestId: parsed.id,
          payload: parsed,
          error: !!parsed.error,
        });
        this.pendingMethods.delete(parsed.id);

        const resolver = this.messageResolvers.get(parsed.id);
        const rejecter = this.messageRejecters.get(parsed.id);
        if (resolver && rejecter) {
          this.messageResolvers.delete(parsed.id);
          this.messageRejecters.delete(parsed.id);
          if (parsed.error) {
            console.error('JSON-RPC error:', parsed.error);
            // The ACP adapter puts the concrete cause (e.g. a stopped Pi
            // process) in data.details. Retain that text in the session banner
            // instead of reducing every adapter failure to 'Internal error'.
            const message = typeof parsed.error.message === 'string' && parsed.error.message
              ? parsed.error.message : 'Unknown error';
            const details = typeof parsed.error.data?.details === 'string'
              ? parsed.error.data.details.trim() : '';
            rejecter(new Error(details && details !== message ? `${message}: ${details}` : message));
          } else {
            resolver(parsed.result);
          }
        }
      }

      // Handle JSON-RPC request from agent (has id and method)
      if ('id' in parsed && parsed.id !== undefined && 'method' in parsed) {
        // Track incoming request from agent
        store.addEntry({
          direction: 'in',
          type: 'request',
          method: parsed.method,
          requestId: parsed.id,
          payload: parsed,
        });
        this.handleRequest(parsed.id, parsed.method, parsed.params);
      }

      // Handle JSON-RPC notification (no id, has method)
      if (!('id' in parsed) && parsed.method) {
        // Track incoming notification
        store.addEntry({
          direction: 'in',
          type: 'notification',
          method: parsed.method,
          payload: parsed,
        });
        this.handleNotification(parsed.method, parsed.params);
      }
    } catch (e) {
      console.error('Failed to parse message:', message, e);
    }
    // A response may have drained the last in-flight request.
    if (this.messageResolvers.size === 0) this.clearIdleTimer();
  }

  private async handleRequest(id: number | string, method: string, params: unknown): Promise<void> {
    let result: unknown;
    let error: { code: number; message: string } | undefined;

    try {
      switch (method) {
        case 'fs/read_text_file':
          if (!this.fsAvailable) {
            error = { code: JSONRPC_METHOD_NOT_FOUND, message: 'fs/read_text_file not available on this client' };
          } else {
            result = await this.readTextFile(params as ReadTextFileRequest);
          }
          break;
        case 'fs/write_text_file':
          if (!this.fsAvailable) {
            error = { code: JSONRPC_METHOD_NOT_FOUND, message: 'fs/write_text_file not available on this client' };
          } else {
            result = await this.writeTextFile(params as WriteTextFileRequest);
          }
          break;
        case 'session/request_permission':
          result = await this.requestPermission(params as RequestPermissionRequest);
          break;
        default:
          error = { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${method}` };
      }
    } catch (e) {
      error = { code: -32603, message: e instanceof Error ? e.message : String(e) };
    }

    // Send response back to agent
    const response = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };

    // Track outgoing response
    const store = getTrafficStore();
    store.addEntry({
      direction: 'out',
      type: 'response',
      method,
      requestId: id,
      payload: response,
      error: !!error,
    });

    this.noteTraffic();
    await this.transport.send(JSON.stringify(response));
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      if (this.onSessionUpdate) {
        this.onSessionUpdate(params as SessionNotification);
      }
    }
  }

  private async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    };

    // Track outgoing request
    const store = getTrafficStore();
    store.addEntry({
      direction: 'out',
      type: 'request',
      method,
      requestId: id,
      payload: request,
    });
    this.pendingMethods.set(id, method);

    return new Promise((resolve, reject) => {
      this.messageResolvers.set(id, (response) => {
        resolve(response as T);
      });
      this.messageRejecters.set(id, reject);
      this.noteTraffic();

      this.transport.send(JSON.stringify(request)).catch((e) => {
        this.messageResolvers.delete(id);
        this.messageRejecters.delete(id);
        this.pendingMethods.delete(id);
        if (this.messageResolvers.size === 0) this.clearIdleTimer();
        reject(e);
      });
    });
  }

  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {},
    };

    // Track outgoing notification
    const store = getTrafficStore();
    store.addEntry({
      direction: 'out',
      type: 'notification',
      method,
      payload: notification,
    });

    this.noteTraffic();
    await this.transport.send(JSON.stringify(notification));
  }

  // ACP Agent methods (client calls these to talk to agent)
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return this.sendRequest<InitializeResponse>('initialize', params);
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.sendRequest<NewSessionResponse>('session/new', params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.sendRequest<LoadSessionResponse>('session/load', params);
  }

  /**
   * List the sessions the agent itself knows about (its own history store, not
   * this client's): `session/list`. Only callable when the agent advertised the
   * `session/list` capability during initialize. Pages are cursor-based — the
   * agent caps the page size, so callers loop on `nextCursor`.
   */
  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.sendRequest<ListSessionsResponse>('session/list', params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.sendRequest<PromptResponse>('session/prompt', params);
  }

  /** Native, non-interrupting steering, advertised by initialize._meta.steering. */
  async steerPrompt(params: PromptRequest): Promise<{ outcome: 'injected' | 'startedNewTurn' | 'failed' }> {
    return this.sendRequest('_session/steering', params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.sendNotification('session/cancel', params);
  }

  async setMode(params: { sessionId: string; modeId: string }): Promise<void> {
    await this.sendRequest('session/set_mode', params);
  }

  /**
   * `session/set_config_option` — the experimental select-based surface
   * some agents (OpenCode, Devin) use for mode/model changes instead of
   * `session/set_mode`/`session/set_model`.
   */
  async setConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<unknown> {
    return this.sendRequest('session/set_config_option', params);
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    await this.sendRequest('session/set_model', params);
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.sendRequest<AuthenticateResponse>('authenticate', params);
  }

  // ACP Client interface methods (agent calls these)
  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.pendingPermissionRequest.value = {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? '',
          kind: params.toolCall.kind ?? 'other',
          status: (params.toolCall.status as 'pending' | 'in_progress' | 'completed' | 'failed') ?? 'pending',
          locations: params.toolCall.locations ?? undefined,
        },
        options: params.options.map((opt) => ({
          kind: opt.kind,
          name: opt.name,
          optionId: opt.optionId,
        })),
      };
      this.permissionResolver = resolve;
    });
  }

  resolvePermission(optionId: string): void {
    if (this.permissionResolver) {
      this.permissionResolver({
        outcome: {
          outcome: 'selected',
          optionId,
        },
      });
      this.permissionResolver = null;
      this.pendingPermissionRequest.value = null;
    }
  }

  cancelPermission(): void {
    if (this.permissionResolver) {
      this.permissionResolver({
        outcome: {
          outcome: 'cancelled',
        },
      });
      this.permissionResolver = null;
      this.pendingPermissionRequest.value = null;
    }
  }

  async sessionUpdate(_params: SessionNotification): Promise<void> {
    // This is called by the agent, we handle it in handleNotification
  }

  async writeTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    try {
      await hostWriteTextFile(params.path, params.content);
      return {};
    } catch (e) {
      console.error('writeTextFile failed:', params.path, e);
      throw e;
    }
  }

  async readTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    try {
      let content = await hostReadTextFile(params.path);
      // Handle line/limit parameters if specified
      if (params.line !== undefined || params.limit !== undefined) {
        const lines = content.split('\n');
        const startLine = params.line ? params.line - 1 : 0; // 1-based to 0-based
        const endLine = params.limit ? startLine + params.limit : lines.length;
        content = lines.slice(startLine, endLine).join('\n');
      }

      return { content };
    } catch (e) {
      console.error('readTextFile failed:', params.path, e);
      throw e;
    }
  }
}

/**
 * Factory: connect a transport for the given agent and wrap it in an
 * `AcpClientBridge`.
 *
 * For backward compatibility, the legacy single-argument form (passing an
 * `AgentInstance` for an already-spawned stdio process) is still accepted and
 * routes through a freshly attached `StdioTransport`. The stdio transport
 * is lazy-imported so it never lands in the web bundle.
 */
export async function createAcpClient(
  arg: AgentInstance | { name: string; config: AgentConfig },
  options?: { fsAvailable?: boolean }
): Promise<AcpClientBridge> {
  if ('config' in arg) {
    const transport = await createTransport(arg.name, arg.config);
    return new AcpClientBridge(transport, options);
  }
  // Legacy path: caller already invoked spawnAgent and just wants us to wire
  // up the events.
  const { StdioTransport } = await import('./transport/stdio');
  const transport = new StdioTransport(arg);
  await transport.attach();
  return new AcpClientBridge(transport, options);
}
