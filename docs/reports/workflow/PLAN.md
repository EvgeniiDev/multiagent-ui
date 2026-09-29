# PLAN — Workflow mode (workstream `cc/workflow`)

Scope: replace the `WorkflowView.vue` skeleton body with a live porch-run
stepper. Data comes from the state server's read-only porch endpoints added
in `2e077b9`. Porch logic ports Paseo's `panels/workflow/*` to plain TS under
`src/lib/porch/`, adapted to **this host's actual run-dir format** (verified
below — it differs from Paseo's assumptions in specific, documented ways).

Implementer owns: `src/components/WorkflowView.vue`, `src/lib/porch/**`,
`src/stores/workflow.ts`, `src/features/workflow/**`, workflow tests.
Forbidden: `src/App.vue`, `src/stores/ui.ts`, `server/acp-state-server.mjs`,
`package.json`, build config, bridge files.

---

## 1. The porch event contract on THIS host (verified)

Verified against `~/.cache/pragmatic-orchestration/steer/runs/` — 120 run
dirs, 180,681 audit lines total.

### 1.1 Run-dir layout (steer registry)

```
<root>/runs/<run_id>/
  meta.json        # status, pid, child_pid, exit_code, error, artifacts_dir,
                   # agent_id, backend, backend_binary, cwd, model,
                   # started_at, finished_at, updated_at, task_hash_prefix
  state.json       # { active_turn, active_tools, run_id, status, steers, updated_at }
  audit.jsonl      # THE canonical event stream (porch delegate events tails it)
  final.txt        # present only on some terminal runs
  supervisor.log   # human log, not events
  turns/           # EXISTS but EMPTY in all 120 runs — do not rely on it
  steers/          # cid_*.json steer fingerprints
  mailbox/ control/
```

`porch delegate events RUN_ID` itself tails `audit.jsonl` by byte offset
(`scripts/lib/steer/control.py:399`, `_AuditTail`) — audit.jsonl is the
authoritative event stream, not a byproduct. **Verified.**

### 1.2 audit.jsonl line shapes (verified, quoted)

Shape A — adapter events (`event: "adapter_event"`, dominant ~99.9%):

```json
{"data_preview": " start", "event": "adapter_event", "kind": "text", "ts": "2026-09-29T20:08:10Z"}
{"data_preview": "I'm starting by reviewing the project structure…", "event": "adapter_event", "kind": "thought", "ts": "..."}
{"data_preview": "Ran ls, git", "event": "adapter_event", "kind": "tool", "ts": "..."}
{"data_preview": "{\"tool\": \"read\", \"call_id\": \"call_…\", \"status\": \"running\", \"input\": {...}}", "event": "adapter_event", "kind": "tool_started", "ts": "..."}
{"data_preview": "end_turn", "event": "adapter_event", "kind": "done", "ts": "..."}
{"data_preview": "completed:prompt_result_end_turn", "event": "adapter_event", "kind": "steer_ack", "ts": "..."}
{"data_preview": "idle", "event": "adapter_event", "kind": "turn_completed", "ts": "..."}
{"data_preview": "permission_required: {...}", "event": "adapter_event", "kind": "error", "ts": "..."}
{"data_preview": "usage_update", "event": "adapter_event", "kind": "progress", "ts": "..."}
```

- `data_preview` is truncated to **200 chars** (`preview_text(ev.data, 200)`
  in `supervisor.py:502`); truncated strings end with `…`
  (10,020/180,960 lines truncated — verified). Tool `input`/thoughts are
  previews only; there is no full payload in audit.jsonl.
- `kind:"tool"` lines carry a human summary (`"Ran ls"`, `"Read file"`) —
  emitted by devin/pi adapters. `tool_started`/`tool_completed` lines carry a
  JSON string in `data_preview` (`{tool, call_id, status, input, time}`) —
  emitted by opencode; the JSON itself is often truncated mid-string, so
  parse it defensively (extract `tool`/`call_id` by regex fallback).

Shape B — supervisor events (no `kind`, structured fields):

```json
{"client_id": "steer_…", "delivery_class": "same_turn", "error": "", "event": "steer_result", "evidence": "acp_concurrent_prompt", "ok": true, "status": "request_sent", "ts": "..."}
{"error": "…", "event": "supervisor_error", "trace": "…", "ts": "..."}
{"client_id": "…", "event": "steer_ack_reconcile", "new_status": "completed", "old_status": "request_sent", "ts": "..."}
{"count": 1, "event": "open_messages_failed_on_terminal", "reason": "run_cancelled", "seqs": [1], "ts": "..."}
```

### 1.3 kind → normalized-type mapping (verified from source)

`scripts/lib/events.py` on this host defines the closed `type` vocabulary
Paseo's `NODE_DEFS` were written against, and `STREAM_TO_EVENT` maps adapter
`kind` → `type`. Port this table verbatim (`audit.ts`):

| audit `kind` (or adapter kind) | normalized `type` |
|---|---|
| `text` | `answer_delta` |
| `thought`, `thinking` | `thinking_delta` |
| `tool`, `tool_start`, `tool_started` | `tool_started` |
| `tool_end`, `tool_complete`, `tool_completed` | `tool_completed` |
| `end`, `done`, `run_completed` | `run_completed` |
| `error`, `run_failed` | `run_failed` |
| `result`, `result_success` | `result` |
| `turn_started` / `turn_completed` / `prompt_complete` | same |
| `run_started` | same |
| `retry`, `retry_scheduled` | `retry_scheduled` |
| `progress` | `progress` |
| `steer_ack` | `steer_<status>` when `<status>` is a known steer state (parse `status` = `data_preview` before `:`), else `steer_request_sent` |

Supervisor lines map onto the same vocabulary:
`steer_result.status` → `steer_<status>` (e.g. `request_sent` →
`steer_request_sent`); `steer_ack_reconcile.new_status` → `steer_<status>`;
`supervisor_error` → contributes an error record, not a block;
`open_messages_failed_on_terminal` → `steer_failed`-class marker.

Known steer states (from `KNOWN_EVENT_TYPES`, verified): `steer_accepted`,
`steer_delivering`, `steer_request_sent`, `steer_queued`,
`steer_awaiting_queue_resolution`, `steer_merged`, `steer_running`,
`steer_completed`, `steer_incomplete`, `steer_applied`, `steer_cancelled`,
`steer_superseded`, `steer_dropped`, `steer_abandoned`, `steer_failed`,
`steer_rejected`.

### 1.4 Per-backend coverage (verified by grepping all 120 audits + adapter sources)

| backend | kinds actually emitted | notes |
|---|---|---|
| devin-cli (79 runs) | `text thought tool steer_ack done error progress` | **no `turn_*`, no `tool_completed`** |
| opencode (32 runs) | `text tool_started tool_completed turn_completed done error progress raw` | tool payloads are the JSON strings |
| pi-cli (9 runs) | `text thought steer_ack turn_completed done error progress` | |

Consequence: nodes must not depend on a single backend's vocabulary.
`turn_completed` lights only on opencode/pi runs; devin runs drive the middle
of the stepper from `answer_delta`/`thinking_delta`/`tool_started` alone.

### 1.5 meta.json / state.json status model (verified)

- `meta.status` ∈ `running | completed | failed | cancelled` (counts: 2/94/21/3).
- Terminal runs carry `exit_code`, `finished_at`, `error` (null or string,
  e.g. `"permission_required: {...}"`).
- `state.json`: `{active_turn: string|null, active_tools: {...}, steers:
  {<client_id>: {delivery_class, error, evidence, seq, status, updated_at}},
  status, updated_at}`. `active_turn` stays `null` on devin runs (the adapter
  never emits `turn_started`); `state.steers` is populated when steers were
  sent (statuses like `abandoned`, `completed`, `request_sent`).
- `final.txt` is present on only some terminal runs — treat as optional.

### 1.6 normalized/<agent>.jsonl — exists, but unreachable

**Correction to the brief's caution**: this host's porch DOES write
`normalized/<agent_id>.jsonl` in Paseo's exact format — verified live at
`/tmp/pragmatic-orchestration-outputs/run-delegate-gentle-maple-d279/normalized/devin.jsonl`:

```json
{"agent_id": "devin", "backend": "devin-cli", "data": "I'll", "kind": "text", "raw": {...}, "ts": "...", "type": "answer_delta"}
```

Observed types there: `answer_delta`, `thinking_delta`, `tool_started`,
`progress`, `steer_completed`, `run_completed`. BUT it lives under
`meta.artifacts_dir` in `${TMPDIR}/pragmatic-orchestration-outputs` —
ephemeral (only 6/120 runs still have theirs) and **not served** by
`/api/porch/runs/:id`. Baseline reader targets `audit.jsonl`; serving
`normalized` is listed as an optional integration request (§8).

### 1.7 What the endpoint serves (verified, `server/acp-state-server.mjs`)

- `GET /api/porch/runs` → `{runs: [{runId, agentId, backend, model, cwd,
  status, pid, childPid, exitCode, startedAt, finishedAt, updatedAt}]}`
  (camelCase; sorted by `startedAt` desc — server line 107). No `cwd` filter;
  filter client-side if needed.
- `GET /api/porch/runs/:id` → `{meta, state, audit, final}` where `meta` is
  raw meta.json (snake_case), `state` raw state.json (or `null`), `audit` =
  `{text, truncated, size}` = last **512 KiB** of audit.jsonl (first partial
  line already dropped server-side), `final` = final.txt text or `null`.
- Base URL must reuse the storage.ts convention: `VITE_STATE_URL` override,
  else `http://<location.hostname>:25900` passed through `toSecureUrl()`
  (→ `:25910` on https pages). Do NOT hardcode `25900` alone — replicate or
  export `stateServerBase()`. (storage.ts is not in the forbidden list, but
  keep the porch client self-contained — see §3.)

---

## 2. Verdict on feasibility

`audit.jsonl`'s `kind` vocabulary **is sufficient** to drive a per-stage
stepper: after the §1.3 mapping, every Paseo `matchTypes` entry has a
produceable `type` on this host — with two caveats:

1. `run_started` is never emitted as an audit kind on this host → the reader
   synthesizes it from `meta` presence (see §4.2).
2. Per-`agent_id` matching (`answer_delta:<profile>` in the ask direction) is
   impossible from audit lines — they carry no `agent_id`. Profile-fan-out
   nodes stay idle until `normalized` is served. Documented, not faked.

Node statuses: `idle | active | done` per Paseo's rule (last node with a
matched event = active; all before = done), with one addition: when the run
is terminal (`meta.status` ∈ completed/failed/cancelled) the terminal node
renders `done`, never `active`.

---

## 3. File inventory

Create:

| File | Purpose |
|---|---|
| `src/lib/porch/types.ts` | `WfEvent` (normalized-ish event), `RunSummary`, `RunDetail`, `RunStatus`, `Direction`, `NodeDef`, `EventBlock` — shared types only, no runtime deps beyond erasable TS |
| `src/lib/porch/audit.ts` | audit.jsonl parser: line → `WfEvent`; `STREAM_TO_EVENT` port (kind→type); supervisor-line mapping; `steer_ack` status parsing; tool-call `call_id`/`tool` extraction from JSON `data_preview` with truncation-safe fallback |
| `src/lib/porch/status.ts` | `deriveRunStatus(meta, state, audit, final, nowMs)` → `active \| stale \| done \| failed` port of Paseo `readRunStatus`; staleness by `meta.updated_at`/`audit.size` silence (browser has no `pidAlive`) |
| `src/lib/porch/event-blocks.ts` | port of Paseo `event-blocks.ts`: `WfEvent[]` → `text \| reasoning \| tool` blocks; `tool`/`tool_started`+`tool_completed` pairing by `call_id` when present, positional otherwise; marks `…`-truncated previews |
| `src/lib/porch/graph.ts` | `NODE_DEFS: Record<Direction, NodeDef[]>` adapted to §1.3 vocabulary + a `run` fallback direction; adds `prefix*` match entries for the `steer_*` family |
| `src/lib/porch/api.ts` | state-server porch client: `porchBase()` (replicates `stateServerBase()` — `VITE_STATE_URL` → `http://<host>:25900` → `toSecureUrl`), `probePorch()`, `listRuns()`, `getRun(runId)` with `fetchWithTimeout`; nothing reads `import.meta.env` at module top level |
| `src/stores/workflow.ts` | Pinia store: runs list, selected run, parsed events, direction, expanded node, stale/error, poll lifecycle, persistence (`workflow.json` via `loadKvStore`) |
| `src/features/workflow/RunList.vue` | run picker table (runId human part, agent, backend, status, started, cwd tail) |
| `src/features/workflow/WorkflowStepper.vue` | node rows + expand/collapse + block list |
| `src/features/workflow/WorkflowBlock.vue` | one render block (text / reasoning / tool) in flat house style |
| `scripts/test_workflow_porch.mjs` | `node:test` + `node:assert` ports of the three Paseo suites (runs `src/lib/porch/*.ts` via node's native type stripping — node v26.7.0, verified) |

Edit:

| File | Change |
|---|---|
| `src/components/WorkflowView.vue` | Replace skeleton body with the real view (header, direction picker, banners, stepper/run list). Keep the top comment's data-path note, updated |

No other edits. If any forbidden file needs a touch → §8 integration requests.

---

## 4. Module specs

### 4.1 `src/lib/porch/api.ts`

```ts
export interface PorchRunSummary { runId, agentId, backend, model, cwd,
  status, pid, childPid, exitCode, startedAt, finishedAt, updatedAt }
export interface PorchRunDetail { meta, state, audit: {text,truncated,size}|null, final: string|null }
probePorch(): Promise<boolean>            // GET <base>/health, 1500ms, cache per session like storage.ts
listRuns(): Promise<PorchRunSummary[]>    // GET /api/porch/runs → .runs ?? []
getRun(runId): Promise<PorchRunDetail|null> // GET /api/porch/runs/:id; 404→null
```

`porchBase()` — copy the 10 lines of `stateServerBase()` semantics
(`storage.ts:90-99`): `import.meta.env.VITE_STATE_URL` wins (inside a
function, not top-level — node:test must import these modules), else
`toSecureUrl(\`http://${location.hostname}:25900\`)`. Import `toSecureUrl`
from `../host/secure` — it's pure and node-safe (`typeof location` guarded).

### 4.2 `src/lib/porch/audit.ts`

```ts
export interface WfEvent { type: string; ts: string; data: string|null;
  agentId: string; toolName?: string; toolId?: string; }
parseAudit(text: string, meta: RunMeta|null): WfEvent[]
```

- Skip non-JSON lines. `event === "adapter_event"` → `type =
  STREAM_TO_EVENT[kind]` (§1.3); `data = data_preview`; for `tool_started`/
  `tool_completed` lines, try `JSON.parse(data_preview)`; on failure regex
  `/"tool": "([^"]+)"/` and `/"call_id": "([^"]+)"/`; `kind:"tool"` → `type:
  tool_started`, `toolName` = preview text (it IS the summary: `"Ran ls"`).
- `steer_ack` → parse `data_preview` as `<status>:<evidence>` →
  `steer_<status>` when known else `steer_request_sent`.
- Supervisor lines (no `kind`): `steer_result`/`steer_ack_reconcile` →
  `steer_<status|new_status>` if in the known set; `supervisor_error` →
  `{type:'run_failed', data:error}`; `open_messages_failed_on_terminal` →
  `{type:'steer_failed', data:reason}`.
- **Synthesized endpoints** (port of the missing kinds): prepend
  `{type:'run_started', ts: meta.started_at}` when meta exists; when
  `meta.status` is terminal and no `run_completed`/`run_failed` was seen,
  append `run_completed` (status completed + exit_code 0) or `run_failed`
  (failed/cancelled or nonzero exit) at `meta.finished_at ?? meta.updated_at`.
- `agentId` — audit lines don't carry it; set from `meta.agent_id` (a run is
  single-agent here; all 120 verified runs are one delegate child).
- Unknown `kind`/`event` values → skip silently (Paseo parity: never throw).

### 4.3 `src/lib/porch/status.ts`

Port `readRunStatus` with the pidAlive call replaced by silence detection:

```ts
export type RunStatus = 'active' | 'stale' | 'done' | 'failed';
export function deriveRunStatus(d: {meta?, state?, audit?, final?}, nowMs,
  staleAfterMs = 180_000): RunStatus
```

- `meta.status` terminal → `failed` if `status !== 'completed'` or
  `exit_code` nonzero or `meta.error` non-empty; else `done`.
- Non-terminal → `stale` when `nowMs - Date.parse(meta.updated_at) >
  staleAfterMs` (and/or `audit.size` unchanged across polls — the store
  tracks the delta; the pure function takes `auditGrew: boolean` as an arg).
- Else `active`. Missing meta → `active` (Paseo parity).

### 4.4 `src/lib/porch/graph.ts`

Keep Paseo's shape (`{id, label, matchTypes}`) but extend matching with a
trailing-`*` prefix rule so the 16-member `steer_*` family is one entry:
`matchTypes` entry `steer_*` matches any type starting `steer_`.

Proposed defs (designed for §1.3–1.4 reality; `direction` is per-run):

```ts
NODE_DEFS.delegate = [
  { id:'contract',    label:'Contract',      matchTypes:['run_started'] },
  { id:'first-minute',label:'First minute',  matchTypes:['answer_delta','tool_started'] },
  { id:'supervise',   label:'Supervise',     matchTypes:['thinking_delta','tool_completed'] },
  { id:'steer',       label:'Steer / cancel',matchTypes:['steer_*'] },
  { id:'wait',        label:'Wait',          matchTypes:['turn_completed','prompt_completed'] }, //sic: prompt_complete
  { id:'acceptance',  label:'Acceptance',    matchTypes:['result','run_completed','run_failed'] },
]
NODE_DEFS.run = [start / work(answer_delta,thinking_delta,tool_started,tool_completed)
                 / steer(steer_*) / finish(result,run_completed,run_failed)]
NODE_DEFS.ask / code / pipeline = Paseo's, kept for parity — they will render
  idle nodes on this host (no such runs exist; ask needs normalized agent_ids)
```

Direction inference: `meta.artifacts_dir` basename is `run-<direction>-…`
(verified: all 120 are `run-delegate-*`) → default direction per run; fall
back to `'run'`. A manual picker still exists (§6).

### 4.5 `src/stores/workflow.ts`

House pattern (`board.ts`/`claims.ts`): `defineStore('workflow', …)` with
refs; `initWorkflowStore()` loads `workflow.json` (`direction`,
`selectedRunId`, `followLatest`) via `loadKvStore`.

State: `runs: PorchRunSummary[]`, `detail: PorchRunDetail|null`,
`events: WfEvent[]` (parsed once per poll from the audit tail — see §5),
`direction`, `selectedRunId: string|null`, `followLatest = true`,
`expandedNodeId`, `runStatus`, `stale`, `errorMessage: string|null`,
`lastAuditSize`.

Actions: `tick()` (one poll pass: `listRuns` → reconcile selection →
`getRun(selected)` → parse → derive status), `selectRun(id)` (sets
`followLatest=false`), `setDirection(d)`, `toggleNode(id)`,
`startPolling()/stopPolling()`.

Selection rule: when `followLatest` — pick newest `status==='running'` run,
else the newest run overall; a new `runId` appearing while following switches
the view to it ("auto-opens the run the moment porch starts one" — the
achievable reading of "auto-trigger", see §7).

### 4.6 `WorkflowView.vue` + features/workflow/*

Structured like `BoardView.vue`: `script setup`, stores, `onMounted`
(init + startPolling), `onUnmounted` (stopPolling — the view is `v-if`'d in
`App.vue:691`, so unmount cleanly stops network traffic).

Reuse the BoardView CSS conventions verbatim in scoped styles: `.view-pane`,
`.pane-head` + `.pane-note`, `.tab-bar`/`.tab-btn` for the direction picker,
hairline `var(--border-faint)`, `var(--text-muted)`, `var(--text-accent)`,
mono for meta numbers. No shadows/gradients/emoji; status glyphs as text
(`●`/`✓`) or a 6px CSS dot — check `BoardCardItem.vue`/`AgentsTab.vue` for
the existing status-dot convention and copy it.

---

## 5. Polling / live-update strategy

- `WORKFLOW_POLL_MS = 2000` (Paseo parity). Poll only while the view is
  mounted; `document.visibilityState` check inside `tick()` is optional.
- The endpoint always returns the last 512 KiB (`audit.truncated`,
  `audit.size`). **Re-parse the whole tail each poll** — ≤ ~5k lines, O(n)
  projection, trivially cheap at 2 s; inherently consistent across the
  truncation boundary. Paseo's line-count cursor is not needed — the server
  already bounds the read. (Keep `readNewEvents`-style incremental parsing
  out of v1; note it as a micro-optimization if profiling says otherwise.)
- Stale: `meta.status` running + `meta.updated_at` older than 3 min AND
  `audit.size` unchanged since previous poll → stale banner "no output for
  N min" (the honest wording Paseo uses — the browser cannot prove the pid
  is dead).
- Error: `meta.status` failed/cancelled or `kind:"error"`/`supervisor_error`
  lines present → error banner (text = `meta.error` else latest error
  preview).
- `audit.truncated === true` → footer note "showing last 512 KiB".

---

## 6. UI breakdown

```
WorkflowView.vue                      (view-pane)
├─ header.pane-head                  "Workflow" + pane-note:
│                                    "<runId-tail> · <agent>@<backend> · <model> · <status> · <elapsed>"
├─ nav.tab-bar                       direction picker: Run | Delegate | Ask | Code | Pipeline
│                                    (auto-follows the selected run's inferred direction;
│                                     manual pick overrides for the session)
├─ banner rows                       stale / error (hairline, surface1 bg — Paseo parity)
├─ .pane-body
│   ├─ RunList.vue                   when followLatest && >1 recent run, or always as a
│   │                                collapsible top strip: newest ~20 runs, click to pin
│   └─ WorkflowStepper.vue           nodes for NODE_DEFS[direction]
│       └─ node row (button): index · label · status glyph (idle muted / active accent / done ✓)
│          └─ expanded → WorkflowBlock list (scroll, max-height ~320px like Paseo)
│             ├─ text:   assistant text (deltas concatenated; render via `marked`+v-html
│             │          ONLY if ChatView already sanitizes this way — check
│             │          src/components/ChatView.vue; else plain <pre-wrap> text)
│             ├─ reasoning: muted italic behind a ▸/▾ toggle (Paseo parity)
│             └─ tool:   hairline card, `name · status`, input/output mono blocks;
│                        mark `…`-truncated previews
└─ empty states                      no state server → "porch endpoint unreachable" hint;
                                     no runs → "No porch runs yet" + one-line how-to
                                     (porch-dispatch); run picked, no events → stepper
                                     skeleton rows, all idle
```

Copy BoardView's `@media (max-width: 800px)` pane-note/tab behavior.

---

## 7. Run selection & triggering — decided

**The view lists and opens existing runs; it does not dispatch.**

- Verified: the state server has **no** write/dispatch route
  (`acp-state-server.mjs:267-407` — GET/PUT/DELETE on `/api/state/*`, GET-only
  `/api/porch/*`). Porch runs start on the host via `scripts/porch-dispatch`
  → `porch delegate -a <agent> --detach` — a shell CLI, unreachable from the
  browser.
- The "auto-triggers porch" voice spec maps cleanly onto: poll the registry;
  when a new run appears (and nothing is pinned), the view switches to it
  live. That is the `followLatest` behavior in §4.5 — the mode effectively
  picks up a porch run the instant porch registers it.
- Scope filtering: `runs` carry `cwd`; `uiStore.activeProjectId` →
  `projects.json` `path`. v1 shows the newest ~20 runs globally (120 runs
  total, cheap); add `run.cwd === project.path` filtering only if the
  implementer finds the list noisy — note: `Common` = `/home/hermes/projects`
  would need prefix-matching, so leave it out rather than fake it.
- If a true "Start run" button is wanted → integration request (§8): a
  `POST /api/porch/dispatch` route on the state server that shells
  `porch-dispatch`. NOT built in this workstream (server file is forbidden
  and spawn-from-http needs an owner decision on auth/exposure).

---

## 8. Integration requests (files outside this workstream)

1. **`server/acp-state-server.mjs`** (optional, recommended): extend
   `GET /api/porch/runs/:id` with `normalized: {text,truncated,size}|null` —
   tail of `<meta.artifacts_dir>/normalized/<meta.agent_id>.jsonl`. Present in
   Paseo's exact format; gives untruncated text + structured tool I/O and
   real `agent_id`s (unlocks ask-direction profile nodes). Reader already
   isolates parsing, so this is additive later.
2. **`server/acp-state-server.mjs`** (only if auto-dispatch is approved):
   `POST /api/porch/dispatch {agent, cwd, task}` → `porch-dispatch`.
3. **`package.json`** (only if vitest is preferred): add `vitest` +
   `"test": "vitest run"`. Default plan needs neither — §9.

---

## 9. Test plan

**Runner**: no unit-test infra exists (verified: no `*.test.ts` under `src/`,
no vitest/jest in `package.json`; tests today are `scripts/e2e_*.py|mjs` +
`test_pmgraph.py`). Node v26.7.0 on this host strips TS types natively
(verified: `node /tmp/t.ts` runs). So: `scripts/test_workflow_porch.mjs`
using `node:test` + `node:assert/strict`, importing `../src/lib/porch/*.ts`
directly. Constraints on the lib code, so this works: **erasable TS only**
(no enums, no parameter properties, no namespaces), no `.vue` imports, no
top-level `import.meta.env`/`location` reads. `toSecureUrl` is safe
(guarded).

Port these Paseo suites (the valuable ones), adapted to the audit contract:

- `porch-reader.test.ts` → `status.ts` cases: running+fresh=active,
  running+silent>3min=stale, completed+final=done, completed w/o final=done
  (final.txt is optional here — Paseo's `done-pending` distinction dropped:
  this host writes final.txt unreliably; document the decision), failed
  exit_code/meta.error=failed, cancelled=failed. Plus audit-parse cases:
  `kind:text`→`answer_delta` with delta preserved; `kind:tool` summary →
  `tool_started` with `toolName`="Ran ls"; opencode `tool_started` JSON
  preview → `tool`+`call_id` extracted; truncated JSON preview → regex
  fallback, no throw; `steer_ack` "completed:…" → `steer_completed`;
  `steer_result` supervisor line → `steer_request_sent`; malformed line
  skipped; synthesized `run_started`/`run_completed` bookends.
- `event-blocks.test.ts` → same cases on `WfEvent`: delta concat into one
  text block, thought→reasoning, tool start+complete pairing by `toolId`,
  unpaired completion → standalone done block, unknown type skipped.
- `graph.test.ts` → keep the ordering assertions for `delegate`
  (first-minute < supervise < wait < acceptance) and add: `steer_*` prefix
  entry matches `steer_request_sent`; `run` fallback direction exists;
  every matchType is produceable by the §1.3 map (regression guard —
  Paseo's defs reference `steer_running`/`steer_accepted` etc. that only
  exist via the steer_ack path here).
- Fixture: a real `audit.jsonl` tail captured from a devin run and an
  opencode run (the two dominant backends), ~40 lines each, committed next
  to the test.

Run: `node scripts/test_workflow_porch.mjs`. Verification bar for the
workstream: that script green + `npm run build:web` green (vue-tsc covers
the new TS; the script is outside `src/` so it doesn't affect typecheck).

---

## 10. Risks & open questions

- **Truncated previews are the honest ceiling.** `data_preview` maxes at 200
  chars — expanded nodes show previews, not full tool I/O. The `normalized`
  integration request (§8.1) is the upgrade path; do not pretend otherwise.
- **Only `delegate` runs exist** (120/120 verified). `ask`/`code`/`pipeline`
  directions are defined for parity but render idle steppers — `porch
  review` never registers in the steer registry (`review_ask.sh` has no
  steer writes; only `delegate.sh` does). If review-run registration is
  desired, that's a porch-side change, out of scope.
- **No pipe-plan endpoint.** Porch's `workflow_plans.py` emits plans for the
  review fan-out only and writes them to ephemeral `/tmp` artifacts; nothing
  machine-readable reaches `/api/porch/*`. NODE_DEFS is therefore
  client-owned; if porch later publishes a plan per run, `graph.ts` is the
  single place to swap.
- **`audit.size` vs growth**: `size` is the file size, not a clock — a run
  that only logs unchanged-size updates (impossible for append-only, so
  fine) — keep `meta.updated_at` as the primary staleness input and
  `audit.size` delta as confirmation.
- **Multiple runs per direction**: Paseo merges events across runs; here
  runs are independent delegate children — v1 shows one run at a time
  (picker), which is the honest shape of this data.
- **Open question for the implementer**: does `WorkflowView` scope the run
  list by `activeProjectId` (cwd match) or stay global? Recommended: global
  newest-20 in v1 (§7).
- **`final.txt` unreliability** (present on only some completed runs) —
  `deriveRunStatus` must not gate `done` on it (deviation from Paseo,
  deliberate, noted in §9).

PLAN COMPLETE
