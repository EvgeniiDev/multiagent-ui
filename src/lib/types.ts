// Types for ACP UI application

/**
 * Transport kinds supported by the frontend.
 *
 * - `stdio`: agent runs as a local subprocess (desktop only).
 * - `websocket`: agent listens on `ws://` / `wss://` and speaks ACP over a WebSocket.
 * - `http`: agent listens on `http://` / `https://` and speaks ACP over Streamable HTTP / SSE.
 */
export type AgentTransportKind = 'stdio' | 'websocket' | 'http';

export interface AgentConfig {
  /**
   * Transport kind. Optional for backward compatibility — when omitted, the
   * config is treated as a stdio agent.
   */
  transport?: AgentTransportKind;

  // ----- stdio fields (optional when transport != 'stdio') -----
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // ----- remote fields (used when transport != 'stdio') -----
  url?: string;
  headers?: Record<string, string>;
}

export interface AgentsConfig {
  agents: Record<string, AgentConfig>;
}

/** Returns the effective transport kind for an agent config. */
export function getTransportKind(config: AgentConfig): AgentTransportKind {
  return config.transport ?? 'stdio';
}

/** Type guard: true for legacy / explicit stdio agents. */
export function isStdioConfig(
  config: AgentConfig
): config is AgentConfig & { command: string } {
  return getTransportKind(config) === 'stdio';
}

/** Type guard: true for websocket / http agents with a non-empty URL. */
export function isRemoteConfig(
  config: AgentConfig
): config is AgentConfig & { url: string } {
  const kind = getTransportKind(config);
  return (
    (kind === 'websocket' || kind === 'http') &&
    typeof config.url === 'string' &&
    config.url.length > 0
  );
}

export interface AgentInstance {
  id: string;
  name: string;
}

export interface AgentMessage {
  agent_id: string;
  message: string;
}

export interface AgentStderr {
  agent_id: string;
  line: string;
}

export interface SavedSession {
  id: string;
  agentName: string;
  sessionId: string;
  title: string;
  lastUpdated: number;
  cwd: string;
  supportsLoadSession?: boolean; // Whether the agent supports session/load
  /**
   * Where the entry came from. `local` — created in this client;
   * `agent` — reported by the agent's own `session/list` (the agent owns the
   * history, this client only mirrors the metadata).
   */
  origin?: SessionOrigin;
}

export type SessionOrigin = 'local' | 'agent';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  /** Files that travelled with this user turn (metadata only, for display). */
  attachments?: AttachmentMeta[];
}

export type AttachmentKind = 'image' | 'text';

/** What the transcript needs to render a sent file. */
export interface AttachmentMeta {
  id?: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  /** Data URL for images — lets the transcript show what was sent. */
  previewUrl?: string;
  /**
   * Inline content, set only for attachments recovered from a REPLAYED user
   * message: the agent echoes the file body inside the message text, so the
   * transcript can keep it behind a disclosure. Freshly sent attachments carry
   * their bytes in `Attachment.data` instead and leave this unset.
   */
  body?: string;
}

/**
 * A file staged for the next prompt.
 *
 * Images travel as ACP `image` content blocks (base64) and text files as
 * inline `resource` blocks (`TextResourceContents`), so neither requires the
 * agent to be able to read the client's filesystem — the client and the agent
 * are different machines.
 */
export interface Attachment extends AttachmentMeta {
  /** base64 for images, raw text for text files. */
  data: string;
}

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string }[];
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallInfo;
  options: PermissionOption[];
}

export interface PermissionOption {
  kind: string;
  name: string;
  optionId: string;
}

// Session Modes
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

// Slash Commands
export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
}

// Models
export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
}
