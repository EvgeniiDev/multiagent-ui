// WfEvent[] → render blocks for an expanded stepper node.
//
// Port of Paseo's event-blocks.ts, adapted to this host's audit reality:
//  - tool blocks pair start/completion by `toolId` (opencode call_id) when
//    present, positionally otherwise; several tools may be open at once,
//    so the single openToolKey slot becomes a map.
//  - opencode emits tool_started twice per call (status pending, then
//    running) — a repeated id updates the open card instead of stacking a
//    duplicate one.
//  - previews are capped at 200 chars by porch (`preview_text(…, 200)`);
//    payloads ending in `…` mark the block truncated.
//  - lifecycle/steer events (run_*, turn_*, prompt_complete, steer_*,
//    retry_scheduled) project to muted `meta` lines so the Contract /
//    Steer / Wait / Acceptance nodes are not empty when expanded.
//    `progress` is skipped — ~30% of all audit lines are usage heartbeats.

import type { EventBlock, WfEvent } from './types.ts';

const TRUNC_MARK = '…';

function isTruncated(text: string): boolean {
  return text.endsWith(TRUNC_MARK);
}

interface ToolBlock {
  kind: 'tool';
  name: string;
  status: 'started' | 'done';
  input?: string;
  output?: string;
  truncated?: boolean;
}

interface ProjectorState {
  blocks: EventBlock[];
  textAcc: { text: string; truncated: boolean }[];
  openTools: Map<string, ToolBlock>;
  lastOpenKey: string | null;
}

function flushText(state: ProjectorState): void {
  if (state.textAcc.length > 0) {
    state.blocks.push({
      kind: 'text',
      markdown: state.textAcc.map((t) => t.text).join(''),
      truncated: state.textAcc[state.textAcc.length - 1].truncated || undefined,
    });
    state.textAcc.length = 0;
  }
}

function pushText(state: ProjectorState, data: string | null): void {
  if (data === null) return;
  state.textAcc.push({ text: data, truncated: isTruncated(data) });
}

function startTool(state: ProjectorState, event: WfEvent): void {
  flushText(state);
  const name = event.toolName ?? 'tool';
  const input = event.data ?? undefined;
  // A repeated start for an already-open call_id (opencode pending →
  // running) updates the card in place — the later preview carries the
  // real input.
  if (event.toolId !== undefined) {
    const open = state.openTools.get(event.toolId);
    if (open !== undefined) {
      if (input !== undefined) {
        open.input = input;
        open.truncated = isTruncated(input) || undefined;
      }
      if (event.toolName !== undefined) open.name = event.toolName;
      return;
    }
  }
  const block: ToolBlock = {
    kind: 'tool',
    name,
    status: 'started',
    input,
    truncated: input !== undefined ? isTruncated(input) || undefined : undefined,
  };
  state.blocks.push(block);
  const key = event.toolId ?? `${name}:${state.blocks.length}`;
  state.openTools.set(key, block);
  state.lastOpenKey = key;
}

function completeTool(state: ProjectorState, event: WfEvent): void {
  flushText(state);
  const name = event.toolName ?? 'tool';
  const output = event.data ?? undefined;
  let key: string | null = null;
  if (event.toolId !== undefined && state.openTools.has(event.toolId)) {
    key = event.toolId;
  } else if (
    state.lastOpenKey !== null &&
    state.openTools.has(state.lastOpenKey)
  ) {
    // Positional pairing for previews that carried no call_id.
    key = state.lastOpenKey;
  }
  const open = key !== null ? state.openTools.get(key) : undefined;
  if (open !== undefined) {
    open.status = 'done';
    if (output !== undefined) {
      open.output = output;
      open.truncated = isTruncated(output) || undefined;
    }
    if (key !== null) {
      state.openTools.delete(key);
      if (state.lastOpenKey === key) state.lastOpenKey = null;
    }
  } else {
    // A completion with no matching start (tail window began mid-run).
    state.blocks.push({
      kind: 'tool',
      name,
      status: 'done',
      output,
      truncated: output !== undefined ? isTruncated(output) || undefined : undefined,
    });
  }
}

function pushMeta(state: ProjectorState, event: WfEvent): void {
  flushText(state);
  const data = event.data;
  state.blocks.push({
    kind: 'meta',
    text: data !== null && data !== '' ? `${event.type} — ${data}` : event.type,
    truncated: data !== null && isTruncated(data) ? true : undefined,
  });
}

const META_PREFIXES = ['steer_', 'run_', 'turn_'];
const META_TYPES: ReadonlySet<string> = new Set([
  'prompt_complete',
  'retry_scheduled',
]);

function projectOne(state: ProjectorState, event: WfEvent): void {
  switch (event.type) {
    case 'answer_delta':
    case 'result':
      pushText(state, event.data);
      return;
    case 'thinking_delta': {
      flushText(state);
      if (event.data !== null) {
        state.blocks.push({
          kind: 'reasoning',
          text: event.data,
          truncated: isTruncated(event.data) || undefined,
        });
      }
      return;
    }
    case 'tool_started':
      startTool(state, event);
      return;
    case 'tool_completed':
      completeTool(state, event);
      return;
    default:
      if (
        META_PREFIXES.some((p) => event.type.startsWith(p)) ||
        META_TYPES.has(event.type)
      ) {
        pushMeta(state, event);
      }
      return;
  }
}

/** Map normalized events to UI blocks; unknown types are skipped, never
 * thrown. `agentId` filters to one agent (ask-direction fan-out). */
export function projectEvents(events: WfEvent[], agentId?: string): EventBlock[] {
  const state: ProjectorState = {
    blocks: [],
    textAcc: [],
    openTools: new Map(),
    lastOpenKey: null,
  };
  for (const event of events) {
    if (agentId !== undefined && event.agentId !== agentId) continue;
    projectOne(state, event);
  }
  flushText(state);
  return state.blocks;
}
