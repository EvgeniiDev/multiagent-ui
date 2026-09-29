// Stepper graph: which pipeline stages exist per direction and which
// normalized event types light each node.
//
// Ported from Paseo's NODE_DEFS and adapted to this host's producible
// vocabulary (see audit.ts STREAM_TO_EVENT): the 16-member steer_* family
// collapses into one trailing-`*` prefix entry, and a `run` fallback
// direction exists for artifacts dirs that do not encode one. ask / code /
// pipeline are kept for parity — they render idle nodes here (audit lines
// carry no per-profile agent_id, and only delegate runs are registered).

import type { Direction, NodeDef, RunMeta, WfEvent } from './types.ts';

export type { Direction, NodeDef };

const ASK_PROFILES = ['spark', 'luna', 'kimi-k3', 'glm', 'deepseek', 'qwen'] as const;

export const NODE_DEFS: Record<Direction, NodeDef[]> = {
  delegate: [
    { id: 'contract', label: 'Contract', matchTypes: ['run_started'] },
    {
      id: 'first-minute',
      label: 'First minute',
      matchTypes: ['answer_delta', 'tool_started'],
    },
    {
      id: 'supervise',
      label: 'Supervise',
      matchTypes: ['thinking_delta', 'tool_completed'],
    },
    { id: 'steer', label: 'Steer / cancel', matchTypes: ['steer_*'] },
    { id: 'wait', label: 'Wait', matchTypes: ['turn_completed', 'prompt_complete'] },
    {
      id: 'acceptance',
      label: 'Acceptance',
      matchTypes: ['result', 'run_completed', 'run_failed'],
    },
  ],
  run: [
    { id: 'start', label: 'Start', matchTypes: ['run_started'] },
    {
      id: 'work',
      label: 'Work',
      matchTypes: ['answer_delta', 'thinking_delta', 'tool_started', 'tool_completed'],
    },
    { id: 'steer', label: 'Steer', matchTypes: ['steer_*'] },
    {
      id: 'finish',
      label: 'Finish',
      matchTypes: ['result', 'run_completed', 'run_failed'],
    },
  ],
  ask: [
    { id: 'triage', label: 'Triage', matchTypes: ['turn_started'] },
    ...ASK_PROFILES.map((profile) => ({
      id: `profile-${profile}`,
      label: profile,
      matchTypes: [`answer_delta:${profile}`, `result:${profile}`] as const,
    })),
    { id: 'verdict', label: 'Verdict', matchTypes: ['run_completed', 'run_failed'] },
  ],
  code: [
    { id: 'triage', label: 'Triage', matchTypes: ['turn_started'] },
    { id: 'depth', label: 'Depth', matchTypes: ['answer_delta', 'tool_started'] },
    { id: 'report', label: 'Report', matchTypes: ['result', 'run_completed', 'run_failed'] },
  ],
  pipeline: [
    { id: 'ask', label: 'Ask', matchTypes: ['answer_delta'] },
    { id: 'ask-delegate-bridge', label: 'Fix → delegate', matchTypes: ['turn_completed'] },
    { id: 'delegate', label: 'Delegate', matchTypes: ['tool_started', 'steer_*'] },
    { id: 'delegate-code-bridge', label: 'Check → code', matchTypes: ['turn_completed'] },
    { id: 'code', label: 'Code', matchTypes: ['answer_delta', 'tool_started'] },
    { id: 'acceptance', label: 'Acceptance', matchTypes: ['result', 'run_completed', 'run_failed'] },
  ],
};

export const DIRECTIONS: readonly Direction[] = ['run', 'delegate', 'ask', 'code', 'pipeline'];

/**
 * Does `event` light `def`? Match entries:
 *  - `family_*`        — trailing `*` prefix on the type (`steer_*` covers
 *                        every steer state, incl. ones only steer_result
 *                        produces here)
 *  - `type:agent`      — qualified, matches `${type}:${agentId}` (ask's
 *                        per-profile nodes)
 *  - `type`            — bare type, matches regardless of agentId
 */
export function matchesNode(event: WfEvent, def: NodeDef): boolean {
  for (const m of def.matchTypes) {
    if (m.endsWith('*')) {
      if (event.type.startsWith(m.slice(0, -1))) return true;
    } else if (m.includes(':')) {
      if (`${event.type}:${event.agentId}` === m) return true;
    } else if (event.type === m) {
      return true;
    }
  }
  return false;
}

/** Index of the last node any event matches (-1 = nothing matched). The
 * node at that index renders `active`; all before it `done`. */
export function activeIndex(nodes: NodeDef[], events: WfEvent[]): number {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (events.some((e) => matchesNode(e, nodes[i]))) return i;
  }
  return -1;
}

/**
 * Direction encoded in `meta.artifacts_dir` (`…/run-<direction>-<name>` —
 * all runs on this host are `run-delegate-*`). Falls back to `run`.
 */
export function inferDirection(meta: RunMeta | null): Direction {
  const dir = typeof meta?.artifacts_dir === 'string' ? meta.artifacts_dir : '';
  const base = dir.split('/').filter(Boolean).pop() ?? '';
  const m = /^run-([a-z]+)(?:-|$)/.exec(base);
  const candidate = m?.[1] as Direction | undefined;
  return candidate !== undefined && candidate in NODE_DEFS ? candidate : 'run';
}
