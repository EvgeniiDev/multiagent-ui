# P5 — Idea Preparation: карточка/чат, браузер, реальный runner, приёмка

Date: 2026-10-02 UTC. Branch `feat/agent-modes`. Author: Devin (SWE-2 Max),
single executor (Porch `run_fair-oak-84a6`).
Scope: **only** P5 of `docs/plans/agent-idea-preparation-plan.md` lines
131–145 + the Verification Contract: one durable discussion in the real
card UI, bindings/compatibility, explicit approvals and gates, explicit
handoff, persistence across reload/restart, honest fail-closed controls —
all proven on the real Compose runner with the real Pi profile, not on
test doubles. P0–P4 modules are reused in place; no Fusion implementation,
no Orchestrator/Swarm, no Tauri, no provider/plugin/skill-source edits.

## STATUS: DONE

## вывод

P5 exposes the existing preparation domain through the actual application:
the runner hosts the P3 lead as a supervised per-card service over real
`pi --mode rpc`, the state server serves the preparation view/commands, and
the card drawer carries one durable discussion with bindings, gates,
documents and handoff. Every runtime gate the P3/P4 reports deferred is now
measured, on the isolated U7 Compose stack (state dir
`~/.hermes/acp-ui-state-u7`, project `acp-ui`), not in-process:

- **One durable discussion in the card/chat.** `PreparationPanel.vue`
  mounts inside `CardDrawer` only when the card is managed AND the card
  view advertises `features.preparation`. The panel renders the durable
  session (id, phase, status, checkpoint restatement), the question list
  with answers, gates, bindings, handoffs and blockers — all from the
  polled server view; nothing is optimistic. A5–A10: a real Pi question
  was answered in the UI, survived a browser reload and a second tab with
  the same `sessionId`.
- **Real lead on the real transport.** `supervisor.mjs` is a runner-side
  host: it sweeps the managed index for cards whose durable attempt is
  `running`, seeds a per-session Pi agent dir from `~/.pi/agent` (auth +
  model settings; missing auth fails closed), and drives
  `createPreparationLead` through the **default** `pi-rpc` transport —
  no fake factory in production. Evidence: E2E phases A/F ran live model
  turns inside `acp-ui-runner-1`; the smoke ran all six available bindings
  through the same supervisor→lead→pi-rpc path in-process with real auth,
  including a dispose+rebuild (supervisor restart) per binding.
- **Bindings and compatibility are explicit and fail-closed.** The card
  start/restart form lists stage bindings from
  `GET /api/execution/preparation/bindings`; unsupported entries render
  disabled with their reason (`route_out_of_scope`,
  `capability_absent`, …) — D2/D3. Selecting one refuses 422 at the API
  (`route_unsupported`, D1; all six unsupported in the smoke). Binding
  assignment preflights route/adapter/host/manifest before minting gates;
  an explicit `change_skill_binding` mints fresh pending gates and
  invalidates dependent confirmed ones (C13/C14/C16).
- **Approvals and gates are exact.** Requirements and plan are approved by
  exact `{versionId, sha256}` (C5/C11); a plan additionally requires a
  confirmed non-empty checks array (`plan_checks_missing` otherwise). A
  gate binds the **presented** subject at confirm time: adopted documents
  confirm legitimately (C3), a gate with nothing presented refuses 422
  `gate_subject_absent` (C13b), a new document version invalidates the
  confirmed gate (C8) and demands re-approval of the new version (C9).
- **Handoff is a recorded offer, never a dispatch.** `handoff_preparation`
  required readiness (`[]` blockers, C17), recorded a `solo` offer with
  the frozen accepted-inputs snapshot (C18/C20) and minted **zero**
  implementation runs (C19). The UI lists the offer and never implies
  implementation started.
- **Persistence across reload and restart.** Durable session survives
  browser reload (A8/A9), a second tab (A10) and a full
  `compose restart runner` (F1–F3: same sessionId, still answerable by the
  re-discovered supervisor sweep). Stopped sessions keep their checkpoint
  and offer an explicit restart form that mints a *new* session (C24/C25,
  restart path exercised in earlier runs; A2/A3 verify the surface never
  offers a duplicate start for an active session).
- **Honest controls.** Offline (all `/api/execution/**` aborted): a fresh
  load renders no prep panel and no fake session (D4/D5) — the UI cannot
  claim a feature it cannot reach. Feature-off (restored baseline spec):
  `features` absent from the card view, `GET …/preparation` and
  `…/preparation/bindings` both 404. Stale `controlRevision` → 409
  `revision_conflict` (B4); contradictory intent on an active session →
  409 `preparation_active` (B3); unknown question → 422 (B5); racing
  identical starts converge to the one durable session (B1/B2).
- **Race fixed in the panel.** The start form no longer flashes while the
  detailed preparation fetch is still pending on a card whose summary
  already reports a session (`prep-loading` state), and a stopped session
  gets an explicit restart form instead of a dead panel.
- **Legacy continuity.** A managed card with already-accepted documents
  shows a plain start form, is never forced into an interview, and on
  explicit start adopts the accepted document as the presented version
  (E1–E4).

## Files changed (this work only)

| File | Kind | Contents |
|---|---|---|
| `server/execution/preparation/supervisor.mjs` | new | Runner-side lead host: managed-index sweep over cards with durable `running` attempts (parked/awaiting sessions are not re-driven), per-session agent-dir seeding from `~/.pi/agent` (auth + `models.json` + model settings — fail-closed when auth absent), `serviceFromClient` over the internal client, `driveOnce` per card, bounded `dispose`, deterministic config-failure → attempt `blocked` (no restart-budget burn, no misleading `cli_lost`) |
| `server/execution/preparation/lead.mjs` | modified | `existsSync` import fix (every bound turn previously failed `route_unavailable`); `cardId` in the transport-factory ctx; `resolvePlan` gains the card's project path as a read-only root for bound turns/`leadPlan` |
| `server/execution/preparation/session.mjs` | modified | `preparation` summary on card-view; projectPath surfaced on the prep view (lead read root); continuation-adoption presented entries already carried `intentSha256` (R6) — unchanged contract, now exercised end-to-end |
| `server/execution/preparation/skills/adapters.mjs` | modified | minor — binding→lead context plumbing for the supervised path |
| `server/execution/state-service.mjs` | modified | `GET /api/execution/preparation/bindings` (registry listing incl. unsupported entries with reasons); `preparation` summary embedded in `/api/execution/cards` list rows; feature-gated 404 when `ACP_EXEC_PREPARATION` is off |
| `server/acp-runner.mjs` | modified | `createManagedDriver` builds the preparation supervisor when `ACP_EXEC_PREPARATION=1`: own pump (`ACP_PREP_TICK_MS`, floor 250 ms), fenced sweep + bounded dispose inside the driver's drain budget, `describe` surfaces `preparation: {on, sweepMs}` |
| `src/lib/execution/api.ts` | modified | Preparation view/binding/question/gate/handoff TS types; `getPreparation`, `getPreparationBindings`; the 8 user command types on the command map |
| `src/lib/execution/ui-model.ts` | modified | P5 section: gate/binding/question helpers, payload builders matching the server field contract (`answer`, `kind`, `text`, required `mode`), labels; `canStartPrep` refuses only on an *active* session (a stopped session may explicitly start a new one); `canStart`/`canContinue` gated on an active unready session |
| `src/stores/execution.ts` | modified | `CardExecState.preparation` fetched inside `doRefreshCard` (single-flight, revision-aligned); stale view preserved on refresh failure (`prepError` shown, last-known kept); bindings registry loader with `prepBindingsError` |
| `src/features/board/PreparationPanel.vue` | new | The card/chat surface: status/phase/ready, restatement, durable question list with per-question answer inputs, gates with confirm controls, binding selectors (unsupported disabled + reasoned), handoff targets + recorded offers, stale/offline banners, stop, start + restart forms, `prep-loading` anti-race state |
| `src/features/board/CardDrawer.vue` | modified | Mounts `PreparationPanel` for the open card |
| `compose.u7-preparation.yaml` | new | U7 overlay: `ACP_EXEC_PREPARATION=1` (+`START`/`VALIDATION`, `ACP_PREP_TICK_MS=1000`, `ACP_PREP_MODEL=muse-spark-1.3-contributor-free`) on state+runner; read-only `~/.codex` mount on state so Codex-cache pinned resources rehash honestly |
| `scripts/u7_transition.py` | modified | `preparation` mode/overlay selection + logging |
| `scripts/test_preparation_ui.mjs` | new | 16 tests: ui-model gates/payloads/canStart (active refused, stopped allowed, feature-off refused), SFC-loaded panel render (start form, restart form, live discussion, disabled offline controls, loading anti-race) |
| `scripts/test_preparation_runner.mjs` | new | 14 tests: supervisor sweep/drive/park/discovery, per-session agent-dir seeding + auth fail-closed, default pi-rpc transport construction, restart accounting, deterministic config-failure → blocked, dispose |
| `scripts/preparation_skill_smoke.mjs` | new | Real-runtime per-binding probe: production path in-process (state service → supervisor → lead → default pi-rpc → real `pi` + real auth + pinned resources), scripted answers replayed as durable answers, dispose+rebuild persistence, per-binding evidence dir |
| `scripts/e2e_preparation.py` | new | Real-browser suite, 56 checks: A durable discussion/UI answer/reload/second-tab; B racing + stale revisions; C bindings/gates/exact approvals/invalidation/readiness/handoff; D unsupported + offline fail-closed; E legacy adoption; F `compose restart runner` persistence |

## измерено

| Gate | Command | Result |
|---|---|---|
| Deterministic battery (P0–P4 + regressions + new P5 suites) | `node --test scripts/test_preparation_binding.mjs test_preparation_state.mjs test_preparation_skills.mjs test_preparation_lead.mjs test_preparation_handoff.mjs test_preparation_ui.mjs test_preparation_runner.mjs test_execution_ui.mjs test_fusion_controller.mjs test_fusion_handoff.mjs test_execution_environment.mjs test_sfc_loader.mjs test_ui_store.mjs test_workflow_porch.mjs test_ws_transport.mjs` | **243/243 pass, 0 fail**, exit 0, 15.9 s (baseline battery 213 + new UI 16 + new runner 14) |
| Frontend build | `npm run build:web` | exit 0, Vite 6.4.1, 4.12 s; pre-existing >500 kB chunk warning unchanged |
| Binding integrity | `node scripts/preparation_binding_probe.mjs verify all` / `audit all` | 12/12 `ok:true` each; digests verified incl. Codex-cache resources |
| Real Pi per-binding smoke | `node scripts/preparation_skill_smoke.mjs all` | **12 pass / 0 fail** — six `available` bindings each ran a real `pi --mode rpc` lead turn chain through the production supervisor path with a mid-run dispose+rebuild; six `unsupported` bindings refused `422 route_unsupported`. Evidence `/home/hermes/.cache/acp-p5-smoke/run-2026-10-02T23-16-41-652Z/` (transcript.jsonl + audit.jsonl + verdict.json per binding + `summary.json`), log `/tmp/p5-smoke.log` |
| Browser E2E (real Compose stack, real Pi in-container) | `~/.hermes/tools-venv/bin/python scripts/e2e_preparation.py` | **56/56 pass, 0 fail**, exit 0 (measured phase window 43 s; prior runs with cold lead turns ~5–8 min). Session `prep_bd8c0698-…` answered via UI, reloaded, second-tabbed, runner-restarted; complex `prep_b347cd67-…` driven through gates/approvals/handoff with `runs=0` minted. Screenshots `/home/hermes/.cache/acp-u7-devin/e2e-prep-*.png` (8 legs), log `/tmp/p5-e2e-run10.log` |
| Stack transition | `python3 scripts/u7_transition.py preparation` then `restore` + `verify` | preparation spec applied to the isolated `acp-ui` project; after evidence, all scoped services + cron returned to the captured `u7baseline` spec — `verify: all scoped+cron specs match` |
| Feature-off surface | `GET /api/execution/cards/<id>` on restored stack | `features` absent; `GET …/preparation` → 404, `GET …/preparation/bindings` → 404; live stack holds 0 managed cards, panel cannot mount |

## Dirty-tree delta vs baseline

Baseline `/tmp/idea-prep-p5-baseline.status` (118 entries, sha256
`aa1005d5…`) → final `/tmp/p5-final.status` (125 entries). **0 baseline
entries removed.** Added entries: `compose.u7-preparation.yaml`,
`scripts/e2e_preparation.py`, `scripts/preparation_skill_smoke.mjs`,
`scripts/test_preparation_runner.mjs`, `scripts/test_preparation_ui.mjs`,
`src/features/board/PreparationPanel.vue`, `BRIEF_IDEA_P5.md`
(dispatch brief, not produced by this run). All other P5 edits land inside
paths already dirty/untracked in the baseline (`server/execution/preparation/`,
`server/execution/state-service.mjs`, `server/acp-runner.mjs`,
`src/lib/execution/`, `src/stores/execution.ts`,
`src/features/board/CardDrawer.vue`, `scripts/u7_transition.py`).
HEAD unchanged (`fb0a298c…`); nothing committed/pushed/reset.

## Не измерено / остаточные риски

- The E2E uses scripted user answers; the model's question text is real but
  the *content* of long complex interviews is not asserted beyond
  contract/durability — matching the plan's acceptance scope.
- `orchestrator`/`swarm` handoff modes remain `implemented:false` by design;
  the offer is a package with no consumer. Only `solo`/`fusion` are claimed.
- The 500 kB+ bundle warning predates P5 and is unchanged.
- User impact of the redeploy window: the transition worked on the isolated
  `acp-ui` project only; the restore returned all scoped services to the
  captured baseline spec (verified). A dormant `hermes acp` child of
  `bridge-hermes` (zero IO >2 h, no attached clients on :25901) was killed
  once under the AGENTS.md sleeping-agent rule to clear apply's preflight;
  the bridge reported "agent CLI exited" — the action is recoverable by
  starting a new session from its tab.

## Следующий gate

Manager independent re-run of the acceptance commands on this dirty tree.
P5's own gates are all evidenced; whole-feature acceptance is the
manager's call, not this report's.
