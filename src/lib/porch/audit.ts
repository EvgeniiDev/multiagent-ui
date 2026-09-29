// audit.jsonl → WfEvent projection.
//
// audit.jsonl is the canonical porch event stream on this host (the
// supervisor tails it by byte offset; `turns/` is empty and
// `normalized/<agent>.jsonl` lives in an ephemeral artifacts dir the state
// server does not serve). Two line shapes exist:
//
//   adapter events  {event:"adapter_event", kind, ts, data_preview}
//                   — ~99.9% of lines; data_preview is capped at 200 chars
//                     and truncated values end with `…`.
//   supervisor      {event:"steer_result"|"steer_ack_reconcile"|
//                    "supervisor_error"|"open_messages_failed_on_terminal",
//                    …structured fields, no `kind`}
//
// `kind` maps onto Paseo's normalized `type` vocabulary via STREAM_TO_EVENT
// (ported verbatim). Two kinds never appear as audit lines — `run_started`
// and (on runs that die before their done line) the terminal marker — so
// parseAudit synthesizes both bookends from meta.json.
//
// Erasable TS only; no DOM imports — scripts/test_workflow_porch.mjs runs
// this file under node's native type stripping.

import { isFailure } from './status.ts';
import type { RunMeta, WfEvent } from './types.ts';

/** Adapter `kind` → normalized `type` (verbatim port of this host's
 * STREAM_TO_EVENT vocabulary). Unknown kinds parse to undefined and are
 * skipped — never thrown. */
export const STREAM_TO_EVENT: Record<string, string> = {
  text: 'answer_delta',
  thought: 'thinking_delta',
  thinking: 'thinking_delta',
  tool: 'tool_started',
  tool_start: 'tool_started',
  tool_started: 'tool_started',
  tool_end: 'tool_completed',
  tool_complete: 'tool_completed',
  tool_completed: 'tool_completed',
  end: 'run_completed',
  done: 'run_completed',
  run_completed: 'run_completed',
  error: 'run_failed',
  run_failed: 'run_failed',
  result: 'result',
  result_success: 'result',
  turn_started: 'turn_started',
  turn_completed: 'turn_completed',
  prompt_complete: 'prompt_complete',
  run_started: 'run_started',
  retry: 'retry_scheduled',
  retry_scheduled: 'retry_scheduled',
  progress: 'progress',
};

/** The steer_* type family (KNOWN_EVENT_TYPES minus the prefix). */
export const KNOWN_STEER_TYPES: ReadonlySet<string> = new Set([
  'steer_accepted',
  'steer_delivering',
  'steer_request_sent',
  'steer_queued',
  'steer_awaiting_queue_resolution',
  'steer_merged',
  'steer_running',
  'steer_completed',
  'steer_incomplete',
  'steer_applied',
  'steer_cancelled',
  'steer_superseded',
  'steer_dropped',
  'steer_abandoned',
  'steer_failed',
  'steer_rejected',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const TOOL_RE = /"tool"\s*:\s*"([^"]+)"/;
const CALL_ID_RE = /"call_id"\s*:\s*"([^"]+)"/;

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function steerTypeFor(status: string): string | null {
  const t = `steer_${status}`;
  return KNOWN_STEER_TYPES.has(t) ? t : null;
}

/** tool/call_id out of a tool_started|tool_completed data_preview. The
 * payload is a JSON string but previews truncate mid-string, so parse
 * defensively and fall back to regex extraction. */
function extractToolFields(preview: string): { toolName?: string; toolId?: string } {
  try {
    const obj = JSON.parse(preview) as { tool?: unknown; call_id?: unknown };
    const toolName = asStr(obj.tool) || undefined;
    const toolId = asStr(obj.call_id) || undefined;
    if (toolName || toolId) return { toolName, toolId };
  } catch {
    // Truncated preview — regex salvage below.
  }
  const toolName = TOOL_RE.exec(preview)?.[1];
  const toolId = CALL_ID_RE.exec(preview)?.[1];
  return {
    ...(toolName ? { toolName } : null),
    ...(toolId ? { toolId } : null),
  };
}

function adapterEvent(rec: Record<string, unknown>, agentId: string): WfEvent | null {
  const kind = asStr(rec.kind);
  const preview = typeof rec.data_preview === 'string' ? rec.data_preview : null;
  const ts = asStr(rec.ts);

  if (kind === 'steer_ack') {
    // data_preview is "<status>:<evidence>" — e.g. "completed:prompt_result_end_turn".
    const status = (preview ?? '').split(':', 1)[0].trim();
    return {
      type: steerTypeFor(status) ?? 'steer_request_sent',
      ts,
      data: preview,
      agentId,
    };
  }

  const type = STREAM_TO_EVENT[kind];
  if (type === undefined) return null;

  const ev: WfEvent = { type, ts, data: preview, agentId };
  if (type === 'tool_started' || type === 'tool_completed') {
    if (kind === 'tool') {
      // The preview IS the tool summary ("Ran ls", "Read file") — devin/pi
      // adapters emit no structured payload. Keep it as the name and drop
      // it from `data` so the card doesn't render it twice.
      ev.toolName = preview ?? undefined;
      ev.data = null;
    } else {
      // opencode: JSON string in data_preview, often truncated mid-string.
      Object.assign(ev, extractToolFields(preview ?? ''));
    }
  }
  return ev;
}

function supervisorEvent(rec: Record<string, unknown>, agentId: string): WfEvent | null {
  const ts = asStr(rec.ts);
  switch (asStr(rec.event)) {
    case 'steer_result': {
      const status = asStr(rec.status);
      const error = asStr(rec.error);
      return {
        type: steerTypeFor(status) ?? 'steer_request_sent',
        ts,
        data: error || asStr(rec.evidence) || status || null,
        agentId,
      };
    }
    case 'steer_ack_reconcile': {
      const type = steerTypeFor(asStr(rec.new_status));
      if (type === null) return null;
      return { type, ts, data: asStr(rec.new_status) || null, agentId };
    }
    case 'supervisor_error':
      return { type: 'run_failed', ts, data: asStr(rec.error) || null, agentId };
    case 'open_messages_failed_on_terminal':
      return { type: 'steer_failed', ts, data: asStr(rec.reason) || null, agentId };
    default:
      return null;
  }
}

/**
 * Parse the audit tail into normalized events. Never throws; malformed and
 * unknown lines are skipped (Paseo parity).
 *
 * Bookends synthesized from meta:
 *  - `run_started` is never an audit kind on this host — prepended from
 *    meta.started_at so the Contract node can light.
 *  - a terminal meta.status with no seen run_completed/run_failed gets one
 *    appended at finished_at ?? updated_at (covers runs whose done/error
 *    line fell out of the 512 KiB window or was never written).
 */
export function parseAudit(text: string, meta: RunMeta | null): WfEvent[] {
  const agentId = asStr(meta?.agent_id);
  const events: WfEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== 'object' || rec === null) continue;
    const r = rec as Record<string, unknown>;
    const ev =
      r.event === 'adapter_event'
        ? adapterEvent(r, agentId)
        : supervisorEvent(r, agentId);
    if (ev !== null) events.push(ev);
  }

  if (meta) {
    const started = asStr(meta.started_at);
    events.unshift({ type: 'run_started', ts: started, data: null, agentId });
    const status = asStr(meta.status);
    if (
      TERMINAL_STATUSES.has(status) &&
      !events.some((e) => e.type === 'run_completed' || e.type === 'run_failed')
    ) {
      events.push({
        type: isFailure(meta) ? 'run_failed' : 'run_completed',
        ts: asStr(meta.finished_at) || asStr(meta.updated_at),
        data: typeof meta.error === 'string' && meta.error ? meta.error : null,
        agentId,
      });
    }
  }
  return events;
}
