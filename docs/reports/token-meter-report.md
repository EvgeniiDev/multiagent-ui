# Token meter report — card aa3acb08

Branch `cc/token-meter` (off `control-center`). One commit, not merged,
not pushed. Claim held by `hermes-orchestrator`; card state untouched.

Goal: the dashboard's honest running-total math had nothing to count —
`usage_update` reaches it only from Hermes Agent (74 samples) and OpenCode
(1) since 23.09; Devin (35 sessions) and Pi (21) emit none. Implemented a
two-layer meter: exact numbers where an agent reports them, a marked
bridge estimate where it can't.

## 1. OpenCode plugin — exact numbers (`source: "agent"`)

OpenCode never emits `usage_update`, but every AssistantMessage already
carries `tokens: {input, output, reasoning, cache: {read, write}}` and
`cost` (SDK types in
`~/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`,
plugin API in `@opencode-ai/plugin` 1.18.31 — the `event({event})` hook).

Files:

- `deploy/opencode/plugins/acp-token-meter.js` — canonical source.
- `deploy/install.sh` — installs it to `~/.config/opencode/plugins/` (the
  global user-plugin dir; Bun loads every file there, no package.json or
  export-name magic needed).
- Runtime copy verified installed at
  `/home/hermes/.config/opencode/plugins/acp-token-meter.js`.

Behaviour: on `session.idle` → `client.session.messages` → sum
`input+output+reasoning+cache.read+cache.write` across assistant messages
→ `used`; sum of `info.cost` → `cost` (USD); `size` = model context limit
from `client.provider.list` (0 when unresolvable); `cwd` from
`client.session.get().directory`. Sample:
`{at, agentName:"OpenCode", sessionId, cwd, used, size, cost, currency:"USD",
source:"agent"}`.

Writes go through the ledger rev protocol (GET → append `usage[]` → PUT
with rev → retry on 409, ≤6 attempts, 300 ms backoff), `usage[]` capped at
5000. Dedup is two-layer: a per-process `lastReported` map skips a repeat
idle with identical `used+cost`, and `appendUsage` skips when the doc's
last sample for that session already matches. A compaction that drops
older messages can't shrink `used` (clamped to the previous value —
running totals must stay monotone).

Verified (e2e_token_meter, act a+c): two `session.idle` events with canned
messages → exactly one row, `used=457` (100+40+10+5+2 + 200+80+20),
`cost=0.03`, `size=128000`, `source:"agent"`.

## 2. Hermes — already exact, no fallback needed

The host ledger (`~/.hermes/acp-ui-state/activity.json.json`, rev 406)
already contains 74 Hermes Agent samples — `hermes acp` emits real
`usage_update` notifications, which `src/stores/session.ts` records (now
tagged `source:"agent"`). No Hermes-side plugin was required; the bridge
estimator also self-disables per session once any exact row lands (see
below), so the two layers never double-count a Hermes session.

## 3. Bridge estimator — `source: "estimate"` for Devin/Pi

`server/acp-ws-bridge.mjs` (mirrored byte-for-byte to
`deploy/acp-ws-bridge.mjs`, which `deploy/install.sh` installs — the
deploy copy was also stale relative to `server/`, now synced). Live units
under `~/.hermes/` untouched and not restarted.

- Watches NDJSON inside `noteOutbound`/`noteInbound`:
  - client→agent `session/prompt`: chars of all text content blocks; the
    request id is correlated so the response resolves the turn and forces
    a flush.
  - agent→client `session/update` chunks `agent_message_chunk` /
    `user_message_chunk` / `agent_thought_chunk`: chars of text content.
  - `session/new`: remembers cwd per session.
  - `usage_update`: marks the session agent-reported and stops estimating
    it (bridge asks the ledger too — a session that already has exact
    rows never gets an estimate layer).
- `used = ceil(chars / 4)` accumulated per session, monotone; `size = 0`;
  `source: "estimate"`; agentName inferred from `--cmd` (devin→Devin,
  pi-acp→Pi, hermes→Hermes Agent, opencode→OpenCode) or `--agent-name`.
- Throttle ≥ `ACP_TOKEN_METER_INTERVAL_MS` (default 10000) between writes
  per session, plus a flush at each prompt-response. `ACP_TOKEN_METER=0`
  disables; `ACP_STATE_URL` (default `http://127.0.0.1:25900`) targets the
  ledger. Cap 5000 rows, same rev-retry protocol.
- All metering is fire-and-forget inside try/catch — a dead state server
  or a JSON parse failure cannot touch the JSON-RPC path.

Verified (act b+c): fake NDJSON agent behind a spawned repo bridge, real
WebSocket client, two prompt turns on one session → usage rows
`used = [20, 50, 65, 75, 90]` (80 prompt + 3×60 chunks → 65; +40 +60 →
90), all `source:"estimate"`, `size:0`, `agentName:"Devin"`,
`cwd:"/tmp/fake-proj"`. Idle afterwards writes nothing.

## 4. Panel — two layers, honestly labelled

`src/stores/activity.ts`:

- `UsageSample.source?: 'agent' | 'estimate'` — `undefined` (all
  pre-existing rows) reads as `agent`.
- `countableRows()` — if a session has ANY agent-reported sample, its
  estimate rows are excluded from every aggregate (prevents double-count
  while a bridge fills the gap before `usage_update` starts; a
  pure-estimate session keeps its rows).
- `consumedInRange`, `deltaRows`, `consumedByDay` now run on countable
  rows and additionally expose `estTokens` — the part of the consumed
  delta attributable to estimate rows. Delta math itself unchanged
  (verified by e2e_dash_math staying green).
- `recordUsage` dedup considers `source` — an estimate equal in
  used/size/cost to an agent row is still a distinct sample (and dropped
  from aggregates anyway by `countableRows`).
- `syncEntries` now merges remote `usage[]` too, keyed on
  `sessionId|at|used|size|cost|source` — before this, rows appended
  server-side (plugin, bridge) were invisible to an already-running panel
  until reload.

`src/stores/session.ts`: the live `usage_update` handler tags
`source: "agent"`.

`src/components/DashboardView.vue` + `src/features/dashboard/format.ts`:

- `fmtTokensWithEst(tokens, est)` → `"10,000 + ~4,000"` mixed, `"~4,000"`
  all-estimate, plain `"10,000"` exact.
- Summary, by-agent, by-project, by-day and per-session tables all render
  the estimate part with `~`; agent/project/day rows carry
  `data-est="true|false"` (test hooks + CSS hook).
- Day chart: stacked two-segment bars — exact part solid
  (`[data-testid="day-bar"]`), estimate part hatched on top
  (`[data-testid="day-bar-est"]`), tooltip shows both components.
- Legend strip `[data-testid="usage-legend"]` under the summary:
  "N plain = reported by the agent · ~N = bridge estimate (chars ÷ 4)".
- Per-session top-N switched from summing raw `used` (which multiplied
  running totals) to `deltaRows` — a real correctness fix, not just
  labelling.

Verified (act d): fixture of one agent row + one estimate row → summary
`"10,000 + ~4,000"`, Devin row `data-est="true"` cell `"~4,000"`, Hermes
row `data-est="false"`, estimate segment rendered, legend present, zero
pageerrors.

## Commands and output

```
$ npm run build:web
… vue-tsc && vite build … ✓ built in 4.27s   (exit 0)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_token_meter.py
PASS  plugin runner completed
PASS  plugin wrote exactly one agent sample (dedup held)  (rows=1)
PASS  plugin sample is exact + tagged  (row={… 'used': 457, 'size': 128000,
      'cost': 0.03, 'source': 'agent'})
PASS  plugin sample carries size/cost/cwd
PASS  ws client drove two prompt turns
PASS  bridge estimate samples written  (rows=5)
PASS  estimate is chars/4 running total, monotonic per session
      (used series=[20, 50, 65, 75, 90])
PASS  estimate tagged source+size:0+agentName
PASS  idle session writes nothing new  (5 -> 5)
PASS  summary marks the estimated part  (sum-tokens='10,000 + ~4,000')
PASS  legend explains the layers
PASS  by-agent row flags Devin as estimated
PASS  all-estimate agent shows ~N  (cell='~4,000')
PASS  agent-reported row stays plain
PASS  day chart draws the estimate segment  (est bars=1)
PASS  zero pageerrors
16/16 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_dashboard.py   → 16/16
$ ~/.hermes/tools-venv/bin/python scripts/e2e_dash_math.py   →  7/7
$ ~/.hermes/tools-venv/bin/python scripts/e2e_all.py         → 25/26 suites pass;
  only "bridge timeout" fails, and only on its first assertion:
    FAIL repo bridge copy matches the deployed file
      (server/acp-ws-bridge.mjs vs ~/.hermes/acp-ws-bridge.mjs)
  This drift guard is *supposed* to fail here — the estimator lives in the
  repo copy while live units are frozen pending the orchestrator's
  rollout. The other 13 assertions exercise the modified bridge directly
  (watchdog idle-kill, child-exit semantics, >60 s request survival) and
  all pass, so the meter did not regress bridge behaviour.

$ curl -s -o /dev/null -w '%{http_code}' http://192.168.1.222:25808/  → 200
$ curl -sk -o /dev/null -w '%{http_code}' https://192.168.1.222:25809/ → 200
  (acp-https.service was found inactive/dead — pre-existing, unrelated to
  the diff; restarted via `systemctl --user start acp-https.service`.)
```

## Heuristic accuracy — the honest caveat

`used ≈ chars / 4` is a *traffic volume* estimate, not a token count:

- English prose / code is ~3.5–4.5 chars per token → decent ballpark.
- Cyrillic is denser: roughly 1.5–2.5 chars per token for common text
  (worse for rare words) → the estimator **overstates** Russian traffic by
  up to ~2×, proportionally more than for English.
- System prompts, tool calls, thinking blocks, cache reads are invisible
  to the bridge → real context consumption is higher than the estimate.
- Direction and rough magnitude are still right: a 2×-bigger session
  shows ~2× more estimated tokens. Enough to populate a dead dashboard,
  never enough for billing-grade numbers — which is exactly why every
  estimate carries `source:"estimate"`, `size:0`, and a `~` in the UI.

## Not verified

- The plugin has been exercised only against a stub SDK client
  (`e2e_token_meter` act a), not inside a live `opencode acp` session —
  field names come from SDK types, but a real end-to-end idle has not run.
- The real bridges still run the pre-change copy under `~/.hermes/`;
  rollout to live units is the orchestrator's step. The estimator was
  verified only on the spawned repo copy.
- `client.session.get().directory` and `provider.list` model shapes are
  type-derived; a provider whose listing lacks `limit.context` yields
  `size: 0` (harmless, displayed as unlimited).
- Pi traffic through the estimator is verified by the same code path as
  Devin (command-name mapping only differs); no Pi-specific traffic was
  replayed.
- e2e_all: results as run (full output below in git notes / terminal);
  individual suites are independent, and the three affected ones are
  separately green.
