// Shared types for the porch run reader (Workflow mode).
//
// The Workflow view cannot read the steer registry off disk; it polls the
// state server's read-only porch endpoints (GET /api/porch/runs,
// GET /api/porch/runs/:id) and projects the raw payloads into `WfEvent`s.
//
// Keep this module erasable-TS only — the node test runner imports the lib
// directly (no enums, no namespaces, no parameter properties).

/** Normalized event projected from one audit.jsonl line (or synthesized
 * from meta.json for the run bookends this host never emits). */
export interface WfEvent {
  /** Closed vocabulary — see STREAM_TO_EVENT in audit.ts. */
  type: string;
  ts: string;
  /** Text payload: audit `data_preview` (max ~200 chars, may end in `…`),
   * or a supervisor-line field (error / reason / evidence). */
  data: string | null;
  /** audit.jsonl carries no agent id; filled from `meta.agent_id`
   * (runs on this host are single-agent delegate children). */
  agentId: string;
  /** Tool name — or the human summary itself for `kind:"tool"` lines
   * ("Ran ls", "Read file"), which is all devin/pi emit. */
  toolName?: string;
  /** opencode `call_id` — pairs tool_started/tool_completed lines. */
  toolId?: string;
}

/** meta.json / state.json as served — snake_case, all fields optional;
 * parsed defensively so a missing key never throws. */
export interface RunMeta {
  run_id?: string;
  agent_id?: string;
  backend?: string;
  model?: string;
  cwd?: string;
  status?: string;
  pid?: number;
  child_pid?: number;
  exit_code?: number | null;
  error?: string | null;
  artifacts_dir?: string;
  started_at?: string;
  finished_at?: string;
  updated_at?: string;
}

/** GET /api/porch/runs → { runs: [...] } — camelCase summaries sorted by
 * startedAt desc (server-side). */
export interface PorchRunSummary {
  runId: string;
  agentId: string | null;
  backend: string | null;
  model: string | null;
  cwd: string | null;
  status: string | null;
  pid: number | null;
  childPid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
}

export interface PorchAudit {
  text: string;
  /** true when the server tail-cut audit.jsonl to its 512 KiB window. */
  truncated: boolean;
  /** Full audit.jsonl size in bytes — used as the growth signal. */
  size: number;
}

/** GET /api/porch/runs/:id → { meta, state, audit, final }. */
export interface PorchRunDetail {
  meta: RunMeta;
  state: Record<string, unknown> | null;
  audit: PorchAudit | null;
  final: string | null;
}

/** Derived liveness for the banner + stepper. No `done-pending`:
 * this host writes final.txt unreliably, so `done` never gates on it. */
export type RunStatus = 'active' | 'stale' | 'done' | 'failed';

/** Stepper direction. `run` is the fallback for artifacts dirs that do not
 * encode one; ask/code/pipeline exist for Paseo parity and render idle
 * nodes on this host (no such runs are registered). */
export type Direction = 'run' | 'delegate' | 'ask' | 'code' | 'pipeline';

export interface NodeDef {
  id: string;
  label: string;
  /** Match entries: a bare type (`answer_delta`), a type:agent qualifier
   * (`answer_delta:spark`), or a `*` prefix family (`steer_*`). */
  matchTypes: readonly string[];
}

/** One renderable row inside an expanded stepper node. `truncated` marks a
 * preview porch capped at 200 chars (`data_preview` ends with `…`). */
export type EventBlock =
  | { kind: 'text'; markdown: string; truncated?: boolean }
  | { kind: 'reasoning'; text: string; truncated?: boolean }
  | {
      kind: 'tool';
      name: string;
      status: 'started' | 'done';
      input?: string;
      output?: string;
      truncated?: boolean;
    }
  | { kind: 'meta'; text: string; truncated?: boolean };
