STATUS: DONE

## What was built

Workflow mode — a live porch-run stepper fed by the state server's read-only
porch endpoints, replacing the `WorkflowView.vue` skeleton.

- `src/lib/porch/types.ts` — shared types: `WfEvent` (normalized event),
  `RunMeta`, `PorchRunSummary`/`PorchRunDetail`/`PorchAudit` (endpoint
  shapes), `RunStatus`, `Direction`, `NodeDef`, `EventBlock` (text /
  reasoning / tool / meta).
- `src/lib/porch/audit.ts` — audit.jsonl → `WfEvent[]`. Verbatim
  `STREAM_TO_EVENT` port (kind→type), supervisor-line mapping
  (`steer_result`→`steer_<status>`, `steer_ack_reconcile`→`steer_<new>`,
  `supervisor_error`→`run_failed`, `open_messages_failed_on_terminal`→
  `steer_failed`), `steer_ack` `<status>:<evidence>` parsing, tool
  `tool`/`call_id` extraction with regex fallback for mid-string-truncated
  JSON previews, `kind:"tool"` previews treated as the tool name itself
  ("Ran ls"). Synthesizes `run_started` from `meta.started_at` and a
  terminal `run_completed`/`run_failed` when meta is terminal but no
  terminal event was seen. Never throws.
- `src/lib/porch/status.ts` — `deriveRunStatus(detail, nowMs, {staleAfterMs,
  auditGrew})` → `active | stale | done | failed`. pidAlive replaced by
  silence detection: running + `meta.updated_at` older than 3 min AND
  `audit.size` unchanged → stale. `final.txt` never gates `done` (unreliable
  on this host — deliberate deviation from Paseo's `done-pending`).
- `src/lib/porch/event-blocks.ts` — `projectEvents(WfEvent[])` → blocks.
  Tool start/complete pairing by `toolId` (opencode `call_id`), positional
  otherwise; repeated `tool_started` for one call_id (opencode pending →
  running) updates the open card instead of duplicating; `…`-suffixed
  previews mark blocks `truncated`; lifecycle/steer events project to muted
  `meta` lines so Contract/Steer/Wait/Acceptance are not empty when
  expanded; `progress` skipped (~30% of lines are usage heartbeats).
- `src/lib/porch/graph.ts` — `NODE_DEFS` per direction: `delegate`
  (Contract → First minute → Supervise → Steer / cancel → Wait →
  Acceptance), a `run` fallback direction, and `ask`/`code`/`pipeline` kept
  for parity. `steer_*` trailing-`*` prefix matching covers the whole
  16-member family; `type:agent` qualifiers for ask profile nodes.
  `inferDirection(meta)` reads `run-<direction>-*` from
  `meta.artifacts_dir` basename.
- `src/lib/porch/api.ts` — `porchBase()` (VITE_STATE_URL →
  `http://<host>:25900` → `toSecureUrl`, all inside functions — node-safe),
  `probePorch()` (session-cached /health probe), `listRuns()`,
  `getRun(runId)` with fetch timeouts; 404 → null.
- `src/stores/workflow.ts` — Pinia store: 2 s poll (`listRuns` → reconcile
  selection → `getRun` → `parseAudit` → `deriveRunStatus`), follow-latest
  selection (newest `running` run, else newest — a new run auto-opens),
  pin/unpin, error + stale + truncation state, `workflow.json` persistence
  (direction, selectedRunId, followLatest) via `loadKvStore`.
- `src/features/workflow/RunList.vue` — run picker table (run id tail,
  agent, backend, status dot per AgentsTab convention, relative started,
  cwd tail) + "follow latest" resume control.
- `src/features/workflow/WorkflowStepper.vue` — node rows (index · label ·
  count · status glyph idle/active ●/done ✓), expand → block list in a
  320 px scroll.
- `src/features/workflow/WorkflowBlock.vue` — one render block: text via
  `marked`+v-html (ChatView parity), reasoning behind ▸/▾, hairline tool
  card (`name · status`, mono input/output), muted mono meta lines.
- `src/components/WorkflowView.vue` — real view: `pane-head` +
  `<runId> · <agent>@<backend> · <model> · <status> · <elapsed>` pane-note,
  direction tab-bar (Run | Delegate | Ask | Code | Pipeline), stale/error
  banners, run-list strip + stepper, honest empty states. BoardView
  conventions throughout (hairlines, CSS vars, 800 px media rules).
- `scripts/test_workflow_porch.mjs` + `scripts/fixtures/audit-{devin,
  opencode}-tail.jsonl` — real audit tails (39/42 lines) from
  `run_cosmic-quill-41bf` (devin-cli) and `run_dusty-comet-6e81` (opencode).

## Evidence

`npm run build:web` (vue-tsc --noEmit then vite build), tail:

```
dist-web/assets/index-zvB0GEkI.js   617.75 kB │ gzip: 212.35 kB
✓ built in 4.41s
```

`node scripts/test_workflow_porch.mjs`, tail:

```
ℹ tests 50
ℹ suites 6
ℹ pass 50
ℹ fail 0
ℹ duration_ms 31.195005
```

Live check against the real registry (standalone state server on scratch
port, `PORT=25959 STATE_DIR=/tmp/wf-dev-state`):

```
GET /api/porch/runs → 122 runs (2 running devin-cli)
run_lucid-flint-5d56  devin-cli  running   → active | delegate | 865 events | supervise active
run_lucid-meadow-cc80 devin-cli  completed → done    | 2239 events | acceptance done ("run_completed — end_turn")
run_arctic-comet-ab38 opencode   failed    → failed  | 222 events | acceptance done ("run_failed — permission_required:…")
run_coral-onyx-79fa   pi-cli     cancelled → failed  | 23 events  | acceptance done ("run_failed")
run_gentle-delta-bbf6 pi-cli     completed → done    | 23 events  | acceptance done ("run_completed — turn_end")
```

## Deliberate stubs

- **ask / code / pipeline directions** render idle steppers — no such runs
  exist in the steer registry (all 122 are `run-delegate-*`), and audit
  lines carry no per-profile `agent_id`, so `answer_delta:spark` profile
  nodes cannot light until `normalized/<agent>.jsonl` is served (§8 below).
  They exist for parity and are honest, not faked.
- **Tool cards can sit at `started`** on devin/pi runs — those backends
  emit `kind:"tool"` summaries but never `tool_completed`; the audit truly
  doesn't know when the tool finished.
- **Previews are the ceiling**: `data_preview` caps at 200 chars, truncated
  values are marked `…` rather than silently shortened.
- **Stale means silent**, not dead — the banner says "no output for N min"
  because the browser cannot prove the pid is gone.
- **No dispatch button** — the state server is read-only (§7 of PLAN);
  "auto-trigger" is follow-latest: a run porch starts appears and opens on
  the next poll.

## Integration requests

1. `server/acp-state-server.mjs` (recommended): extend
   `GET /api/porch/runs/:id` with `normalized: {text,truncated,size}|null`
   — tail of `<meta.artifacts_dir>/normalized/<meta.agent_id>.jsonl`.
   Untruncated text + structured tool I/O + real agent_ids unlocks the ask
   profile nodes. Parsing is already isolated in `parseAudit`, so this is
   additive.
2. `server/acp-state-server.mjs` (only if auto-dispatch is approved):
   `POST /api/porch/dispatch {agent, cwd, task}` → `porch-dispatch`. Needs
   an owner decision on auth/exposure; not built here.
3. `package.json` (optional): `vitest` + `"test": "vitest run"` if the
   house prefers it over the node:test runner.

## How to review

```
npm run build:web
node scripts/test_workflow_porch.mjs
```

Live: start the stack (`docker compose up -d`) or standalone
`PORT=25900 STATE_DIR=/tmp/state node server/acp-state-server.mjs`, open
the panel, switch to **Workflow** (sidebar / key 5). You should see the
runs table (newest 20) and the delegate stepper; a running porch run has
**Supervise** active. Click any node to expand its streamed blocks; click a
run row to pin it; "follow latest" in the strip header resumes auto-follow;
direction tabs override the inferred direction (click the active tab again
to release the override).

DEV COMPLETE
