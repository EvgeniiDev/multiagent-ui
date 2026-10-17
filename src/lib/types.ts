// Types for ACP UI application

import type { PlanEntry } from '@agentclientprotocol/sdk';

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

  /**
   * Session mode to request right after `session/new`, when the agent
   * advertises it in `modes.availableModes` — e.g. `bypass` on the Devin
   * bridge so panels open without permission prompts. Absent or not
   * advertised: the agent's own default mode wins. Applies to new sessions
   * only; a resumed session keeps the mode it was persisted with.
   */
  defaultMode?: string;
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
  /** Latest live user/agent message observed here; protects against stale inventories. */
  lastMessageAt?: number;
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

/**
 * One ordered renderable piece of a message. The flat `content`/`toolCalls`
 * fields keep accumulation working for history/merge code, while `segments`
 * preserve the arrival order those fields flatten away — a text block sent
 * between two tool calls renders between them instead of gluing onto the
 * previous paragraph, and a chip sits where the call actually ran.
 */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'attachment'; index: number }
  | { kind: 'plan' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  /**
   * Ordered parts as they arrived from the agent. Absent on messages hydrated
   * from pre-segments cache entries — the view falls back to the legacy order
   * (attachments → tools → content) for those.
   */
  segments?: MessageSegment[];
  /** Latest plan snapshot the agent published on this turn (ACP `plan` update). */
  plan?: PlanEntry[];
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
  /**
   * Why this attachment cannot be shown, when it can't. The transcript
   * renders it as an explicit "which file + why" placeholder — an image that
   * is known to have existed must never silently disappear from history.
   */
  unavailableReason?: string;
  /**
   * Pointer into the local attachment cache for bytes too large to keep in
   * the shared state document (see `lib/attachmentHistory.ts`). `cache:` is a
   * file under the OS cache dir (Tauri), `local:` a localStorage key (web).
   */
  cachePath?: string;
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
  /** Parsed call arguments forwarded verbatim by the ws bridge (tool_call / tool_call_update frames). */
  rawInput?: unknown;
  /** Result/output text accumulated from tool_call_update frames (rawOutput, content text blocks, _meta.terminal_output deltas). */
  rawOutput?: string;
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
