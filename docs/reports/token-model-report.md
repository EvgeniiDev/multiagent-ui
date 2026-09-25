# Token model report — card 7987cc40

Branch `cc/token-model` (off `control-center`). One commit, not merged,
not pushed. Card claimed by the orchestrator; stage untouched by me.

Goal: every usage sample in `activity.json → usage[]` now carries the
session's model (and provider where a writer actually knows it), and the
dashboard groups spend by model. Live-verified fact first: **all four
agents do announce the model** — just in two different wire shapes — so
no writer ever has to invent a value; the only honest `unknown`s are for
provider (the wire carries no structured provider field) and for legacy
rows written before the field existed.

## What `session/new` actually returns (probed live, 2026-09-25)

Each agent was spawned directly over stdio (`<cli> acp`), answered
`initialize` + `session/new {cwd, mcpServers:[]}`; the response was
captured verbatim. Probe script at `/tmp/acp-probe/probe3.mjs`.

| Agent | Result keys | Model announcement | Provider on the wire |
|---|---|---|---|
| `hermes acp` | `sessionId, models, modes, _meta` | `models.currentModelId` = `custom:muse-spark-1.3-contributor-free` (512 `availableModels`; ids are `provider:model`, e.g. `openrouter:anthropic/claude-fable-5.1`, `description: "Provider: OpenRouter"`) | embedded as `:`-namespace in the id only |
| `pi-acp` | `sessionId, configOptions, models, modes, _meta` | `models.currentModelId` = `zen-relay/muse-spark-1.3-contributor-free` (529 available) **and** `configOptions[category=model].currentValue` — same value | embedded as `/`-namespace in the id only |
| `opencode acp` | `sessionId, configOptions` | **no `models` block**; `configOptions` select `{id:"model", category:"model", currentValue:"opencode/big-pickle"}` (plus a `mode` select) | `/`-namespace in the value only |
| `devin acp` | `sessionId, modes, configOptions, _meta` | **no `models` block**; `configOptions` select `{id:"model", category:"model", currentValue:"swe-2-high"}` | none at all |

So the extraction rule is: `result.models.currentModelId` when present,
else the `configOptions` entry with `category === 'model'` (Devin and
OpenCode both use `id:"model"` too — either marker suffices). No agent
emits a separate provider field; providers visible today are the
namespaces inside the model id itself (`openrouter:…`, `zen-relay/…`,
`opencode/…`), which we store verbatim inside `model` rather than
splitting out and asserting as fact.

## 1. Schema — `src/stores/activity.ts`

`UsageSample` gained optional `model?: string` and `provider?: string`.
Old rows without them read as `'unknown'` via `sampleModel` /
`sampleProvider` — the same `?? 'agent'` pattern `source` already used.
No migration; the live ledger format is unchanged.

Also in the store:

- `deltaRows()` now also returns `model`/`provider` taken from the
  session's last in-window sample (same last-row semantics as
  `agentName`/`cwd`; a mid-window model switch attributes the whole
  delta to the latest model — noted, acceptable granularity).
- `recordUsage` dedup now includes model+provider: identical totals under
  a *different* model still earn a row (a model switch is information).
- `syncEntries`' remote-merge key includes model+provider, so a remote
  row that differs only in model is not silently dropped.

## 2. Panel — `src/stores/session.ts`

The `usage_update` branch of `handleSessionUpdate` now records
`model: currentModelId.value || 'unknown'` and `provider: 'unknown'`.
`currentModelId` is exactly what the agent announced on `session/new`
(`models.currentModelId`) or what the user last picked via `setModel` —
the panel never sees a structured provider, and agentName → provider is
not a reliable mapping (Hermes alone fronts several providers), so
nothing is invented.

## 3. OpenCode plugin — `deploy/opencode/plugins/acp-token-meter.js`

`report()` already reads `info.providerID` / `info.modelID` off every
assistant message; the appended sample now carries
`model: modelID ?? 'unknown'` and `provider: providerID ?? 'unknown'`.
This is the only writer with a real provider — it comes straight from the
message object. Both dedup layers (`lastReported` map and the ledger
last-row check in `appendUsage`) now compare model+provider too, so a
model switch at unchanged totals still writes one row. The live copy at
`~/.config/opencode/plugins/` was NOT touched; `deploy/install.sh`
already installs this repo file as-is, so no install.sh change was
needed — rollout is the orchestrator's.

## 4. Bridge — `server/acp-ws-bridge.mjs` (mirrored to `deploy/`)

- `meterModelFromResult(result)` implements the extraction rule above;
  applied to both `session/new` and `session/load` responses (load req
  ids are now tracked in `meterLoadReqs`).
- Mid-session switches are tracked too: outbound `session/set_model`
  (`params.modelId`) and `session/set_config_option` with
  `configId === 'model'` (`params.value`) update the meter session.
- `meterFlush` writes `model: s.model ?? 'unknown'`, `provider: 'unknown'`
  — the wire carries no provider field, and that is recorded honestly.
- Write-side dedup (in `meterFlush` + `meterAppend`) now treats a model
  change with unchanged `used` as new information, matching the store.

## 5. Dashboard — `usageByModel` + "By model" panel

- `activity.usageByModel(from, to)` follows `usageByAgent`: per-session
  deltas grouped by `model`, `estTokens` split out for `~` rendering,
  `provider` = first non-unknown provider in the group, turns attributed
  through a sessionId→model map (entries carry no model — a turn-end
  with no countable sample lands in `unknown`).
- `DashboardView.vue`: a third panel in the `.cols` grid —
  `data-testid="by-model-table"` with `by-model-row` rows carrying
  `data-model`/`data-est`, estimate `~` marking, cost groups, share bar,
  last-activity column. Legacy rows group under `unknown`/`unknown`.

## 6. Live ledger cleanup

`~/.hermes/acp-ui-state/activity.json.json` (state-server doc
`activity.json`): backed up to `activity.json.json.bak-20260925-token-model`
first, then the 15 e2e junk rows removed through the rev protocol
(GET → filter → PUT with rev, 409-retry), not by editing the file:

- predicate: `sessionId === 's'` AND `source === 'estimate'` AND
  `agentName` contains `python` (all 15 are
  `/home/hermes/.hermes/tools-venv/bin/python`).
- result: `usage[]` 90 → 75 rows, rev 447 → 448, verified 0 remain.
  The 75 real rows (74 Hermes agent + 1 OpenCode) untouched.

## 7. Tests — `scripts/e2e_token_meter.py` (30 assertions)

- **(a) plugin**: the sample now must carry `model:'mod'`,
  `provider:'prov'` from the canned assistant messages.
- **(b) bridge**: one bridge + fake agent, three sessions —
  `config` (configOptions select → `cfg/fake-model-2`, provider
  `unknown`), `models` + a mid-session `session/set_model` (first rows
  `wire/fake-model-1`, last row `switched/fake-model-9`), and `none`
  (announces nothing → `unknown`/`unknown`). Monotonic `used`, dedup and
  idle-no-write assertions unchanged.
- **(d) dashboard**: fixture now has a modelled agent row, a modelled
  estimate row and a legacy no-fields row → by-model table renders 3 rows,
  the estimate keeps `~`, the legacy row groups under `unknown`.
- **(e) panel writer** (new act): a `route_web_socket` mock announces
  `models.currentModelId` on `session/new` and emits `usage_update` on
  the prompt → the row the panel persists carries
  `model:'panel/fake-model-7'`, `provider:'unknown'`, `source:'agent'`.

## Commands and output

```
$ npm run build:web
… vue-tsc && vite build … ✓ built in 3.89s   (exit 0)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_token_meter.py
30/30 assertions passed

$ ~/.hermes/tools-venv/bin/python scripts/e2e_dashboard.py   → 16/16
$ ~/.hermes/tools-venv/bin/python scripts/e2e_dash_math.py   →  7/7
$ ~/.hermes/tools-venv/bin/python scripts/e2e_all.py         → 26/28 suites
  green. The two failures:
  * "bridge timeout": only its first assertion —
      FAIL repo bridge copy matches the deployed file
    Expected and deliberate — the repo bridge now differs from the frozen
    live copy at ~/.hermes/acp-ws-bridge.mjs pending the orchestrator's
    rollout (same as the previous token-meter card). The other 13
    assertions exercise the modified bridge and pass.
  * "dispatch": a one-shot GET→PUT on claims.json lost a rev race to the
    test's own live dispatchers' heartbeats (plant foreign claim -> 409) —
    a test-internal flake unrelated to this diff; standalone re-run
    passes 56/56.

$ curl -s -o /dev/null -w '%{http_code}' http://192.168.1.222:25808/  → 200
$ curl -sk -o /dev/null -w '%{http_code}' https://192.168.1.222:25809/ → 200
```

## Not verified / honest edges

- Provider is `unknown` from panel and bridge — the ACP wire carries no
  provider field anywhere; for Hermes/Pi/OpenCode it is visible only as
  the id's namespace prefix (`openrouter:x`, `zen-relay/x`, `opencode/x`),
  kept inside `model` verbatim rather than split and asserted as fact.
- A session that switches model mid-window attributes its whole in-window
  delta to the *latest* sample's model (per-session last-row semantics,
  same as agent/cwd attribution) — finer attribution would need
  per-sample deltas.
- The set_model/set_config_option tracking and `session/load` capture are
  covered by the e2e fake agent, not yet by a live agent through a live
  bridge (frozen pending rollout).
- The plugin's providerID/modelID pair was verified against a stub SDK
  client only — same caveat as the previous card.
