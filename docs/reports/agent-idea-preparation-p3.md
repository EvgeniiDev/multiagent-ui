# P3 — Idea Preparation: один ведущий и адаптивное обсуждение

Date: 2026-10-03. Branch `feat/agent-modes`. Author: Devin (SWE-2 Max), single executor.
Scope: **only** P3 of `docs/plans/agent-idea-preparation-plan.md`
(R2–R4, R6, R9–R10, KTD2, KTD5–KTD7). P0/P1/P2
(`docs/reports/agent-idea-preparation-p0.md`, `…-p1.md`, `…-p2.md`) are
dependencies — registry/manifest/containment (P0), session/checkpoint/gate
machinery (P1), binding contracts/adapters/`planInvocation` (P2) are reused
and extended in place. No P4/P5, no Fusion/Orchestrator/Swarm dispatch, no
UI/`src/`, no compose/production changes, no provider/upstream edits, no
target-project writes, no lifecycle/approval-authority changes, no commits.

## STATUS: DONE

## вывод

P3 adds the **single durable discussion lead**: one driver owns the
preparation conversation for a card — it reads the durable session, composes
each turn's prompt from goal/stage/documents/decisions/checkpoint/answers,
runs one bounded CLI turn on a contained Pi RPC process, persists the result
through the internal-command seam, and parks/resumes until the user answers.
One `--name` per session makes the CLI session the same discussion across
process respawns, driver restarts, and binding changes.

- **Durable lead driver** (`lead.mjs`): `createPreparationLead` serializes
  drives per card, tracks `{sessionId → transport state}`, and drives
  `running` attempts only — a parked (`awaiting_answer`) or cleanly
  `completed` attempt keeps its process for the next turn of the same
  discussion; a `cancelled`/`failed`/`blocked` binding tears it down (a dead
  attempt's process can never answer for another). Result application is
  `prep_result`/`prep_question` via `internalCommand` with CAS on
  `internalRevision` and bounded retries — every mutation lands durably
  before the next turn.
- **Two question channels, both durable** (`session.mjs`): a mid-turn native
  dialog is recorded by `prep_question` (question text + `requestId/method/
  options`) while the turn stays in flight; the matching
  `extension_ui_response` for that exact request id delivers the recorded
  answer — no extra prompt. A question returned after the turn settles is a
  `prompt`-channel record answered inside the next prompt. Dedupe by
  normalized text: re-asking an answered question under the same intent
  epoch satisfies the fresh rpc request from the checkpoint; re-presenting
  an open one rebinds the durable record to the fresh request id (S3, S10).
- **Bounded everything**: `noProgressLimit` (consecutive no-progress turns →
  `no_progress` blocker), `maxRestarts` (respawns of a driven attempt →
  `cli_lost` failure), `idleTimeoutMs`/`startTimeoutMs`/`turnTimeoutMs`
  (process silence → `idle_timeout`), `rpcTimeoutMs` per internal command,
  caps on frames, prompt size, artifact size (512 KiB), workspace listing
  (2000 entries), question count. **Human waiting is not a runtime timeout**:
  a parked dialog waits indefinitely — S5 holds a dialog open 3× the turn
  timeout and the attempt completes cleanly once answered.
- **Fail-closed intake**: `blocker` is a whitelisted result channel but is
  legal only under `outcome: 'blocked'` — a blocker under `completed` is
  refused 422 `result_malformed` (S15d). Unknown top-level or smuggled
  nested channels still refuse `result_channel_unsupported` (S15a). A
  malformed `acp-prep` block is preserved verbatim in `note`, never executed
  (S16). Route resolution re-runs `preflightContract` at drive time: a
  binding gone `candidate` after assignment → `route_unproven` blocker, no
  spawn (S15b).
- **Workspace-artifact contracts** (`importAs: document`): the driver
  imports the *real file* matching declared globs — byte-for-byte, never the
  model's claim. A per-turn baseline snapshot (rel→mtime taken before the
  prompt) means a file the turn inherited unchanged cannot back a fresh
  claim; a bare claim is dropped with a `[dropped document claim]` marker
  (S15c).
- **Recovery honest to the durable layer**: CLI death mid-turn respawns the
  process under the same `--name` and resumes the same attempt from the
  checkpoint (S18, bounded by `maxRestarts` → `cli_lost`, S18b); CLI loss
  while parked rebinds the open dialog onto the fresh process's new request
  id (S10); driver restart re-reads the durable view and continues with zero
  extra spawns (S13); `change_skill_binding` respawns only because the plan
  changed — intent, answers, and discussion identity are preserved (S14).
- **Stop semantics**: `stop_preparation` cancels the active attempt;
  `lead.stop()` aborts only that attempt's process — a superseded attempt's
  late `prep_result`/`answer_question`/`prep_question` are refused
  (`stale_attempt`/`attempt_terminal`/`attempt_cancelled`) and its dead rpc
  request is cancelled rather than confirmed (S9, S11, S12).

## Files changed (this work only)

| File | Kind | Contents |
|---|---|---|
| `server/execution/preparation/lead.mjs` | **new** (1181 lines) | `createPreparationLead` — per-card drive chains, transport lifecycle (reuse/park/teardown/respawn), `composeLeadPrompt` (goal/stage/docs/decisions/checkpoint/answers → prompt), turn pump, `extension_ui_request` routing + deduped-answer replay, pending-answer delivery, no-progress/restart bounds, workspace-artifact baseline import, `serviceFromService`/`serviceFromClient` seams, `prepRunDirs`, lead-plan fallback (`--mode rpc`, scoped dirs, `ACP_PREP_*` containment roots, `-e preparation-bridge.ts`, `--no-skills` for unbound) |
| `server/execution/preparation/pi-rpc.mjs` | **new** (270 lines) | real `pi --mode rpc` child transport: NDJSON frames, request-id correlation, `extension_ui_request` surfacing, `respond()` → `extension_ui_response`, bounded stdout/stderr tails + writes + shutdown, alive/exited reporting; **no timeout while parked on human input** |
| `server/execution/preparation/session.mjs` | modified | `prep_question` internal command (mid-turn durable mint/dedupe/rebind); `blocked` outcome + `session.blocker`; `channel`/`dialog`/`intentSha256` fields on question records; `findQuestionDup` (open wins, answered dedupes by text + intent epoch); decision/assumption dedupe; per-attempt `progress` flag; awaiting_answer parks on any open question; view exposes `blocker`, attempt `progress`, question channel/dialog |
| `server/execution/preparation/skills/adapters.mjs` | modified | `blocker` added to the result-channel whitelist with subkey validation (`code`/`detail`/`retryable`, `SAFE_BLOCKER_CODE`); a `blocker` under a non-`blocked` outcome refuses `result_malformed` |
| `server/execution/preparation/skills/registry.mjs` | modified | `unsupported: null` tolerated on parse (validated bindings re-serialize cleanly — drive-by fix found by S15b) |
| `server/execution/execution-domain.mjs` | modified | `prep_question` wired into `INTERNAL_COMMANDS` dispatch |
| `server/execution/internal-transport.mjs` | modified | `getPreparation(cardId)` on `createInternalClient` — runner-side view read over the authenticated internal transport |
| `scripts/fixtures/fake-pi-rpc.mjs` | **new** (209 lines) | deterministic Pi-RPC stand-in: scripted per-spawn turn descriptors (`settle`/`dialog`/`die`/`silence`/`frames`), spawn-index-namespaced dialog request ids (`ui-<spawn>-<seq>`), prompts/responses/pendingDialogs evidence, `plan`/`spawnCtx` capture |
| `scripts/test_preparation_lead.mjs` | **new** (1221 lines) | 23 node:test cases against the real `createStateService` + `internalCommand` + `loadRegistry` + `verifyManifest` seams; only the process transport is faked — see scenario map |
| `docs/reports/agent-idea-preparation-p3.md` | **new** | this report |

Baseline dirt preserved: `git status --short` vs
`/tmp/idea-p3-accepted-baseline.txt` — the **only** new entries are
`?? scripts/fixtures/fake-pi-rpc.mjs`, `?? scripts/test_preparation_lead.mjs`,
and this report. Every other touched path lives inside the already-untracked
`server/execution/preparation/` tree or is itself an untracked baseline file
(`internal-transport.mjs`, `execution-domain.mjs`). **Zero tracked files
modified by this work.** No `src/`, compose, UI, installed-plugin, or
target-project write anywhere in the delta. `node --check` clean on all nine
touched/new modules.

## измерено

All runs on this checkout, this session. `node --test` bare runner; no
services started, no ports touched, no network.

### P3 suite — `node --test scripts/test_preparation_lead.mjs`

```
ℹ tests 23   ℹ pass 23   ℹ fail 0   ℹ duration_ms 2495.6
```

| Test | Plan scenario / requirement |
|---|---|
| S1: small task — unbound lead drives a short route | маленькая задача без полного набора навыков: 1 attempt, 1 process, 2 prompts, `--name prep-<session>` |
| S2: complex task — bound chat route requests additional distinctions | сложная с дополнительными развилками: 3 turns on 1 attempt/1 process; answers ride prompts; `--skill` pinned dir used |
| S3: re-asked answered question dedupes — recorded answer, no second question | уже принятые ответы не спрашиваются повторно: same durable record, recorded answer replayed via `extension_ui_response` |
| S4: consecutive no-progress turns → `no_progress` blocker, no further spawn | бессодержательный цикл достигает лимита/диагностики |
| S5: human wait over a dialog outlives turnTimeoutMs — no timeout | ожидание человека не timeout (dialog parked 3× turn timeout, then answered → completed) |
| S6: dialog answer routes to the same rpc request id — no extra prompt | native dialog получает matching `extension_ui_response` без нового prompt |
| S7: post-turn question is answered through the next prompt | завершённый вопрос получает следующий prompt |
| S8: duplicate answer is a replay — single durable answer, one response | duplicate answer не зависает: idempotent, exactly one respond |
| S9: supersede with open dialog — dead request unanswered, new attempt drives | restart с открытым диалогом не подтверждает чужую попытку |
| S10: CLI loss mid-dialog — rebind to a fresh request id on resume | CLI loss восстанавливает checkpoint; durable question rebinds to `ui-1-*` on the respawned process |
| S11: results and answers on dead/foreign attempts are refused | чужая попытка: late `prep_result`/`answer_question` → `stale_attempt`, no smuggled decision |
| S12: `stop_preparation` cancels the active attempt; `lead.stop` aborts its process | stop отменяет текущую попытку — only that process aborted |
| S13: restart restores the checkpoint — new driver resumes same discussion | restart восстанавливает checkpoint: fresh driver instance, zero extra spawns past the respawn, same `--name` |
| S14: `change_skill_binding` keeps intent/answers under one discussion name | смена навыка сохраняет намерение: checkpoint/answers verbatim, new binding's plan, same `--name` |
| S15a: unsupported result channel fails the turn closed | `{"commands":[…]}` → `result_channel_unsupported`, nothing applied (KTD6) |
| S15b: assigned route gone candidate → `route_unproven` blocker, no spawn | R9 fail-closed at drive time |
| S15c: workspace_artifact imports the REAL file; a bare claim is dropped | artifact = real fresh file; stale-file/bare-claim → `[dropped document claim]` |
| S15d: a blocker under a non-blocked outcome is refused at the seam | `completed`+blocker → 422 `result_malformed` |
| S16: malformed acp-prep block → note preserves the raw text, turn completes | malformed result is evidence, not execution |
| S17: silent process → `idle_timeout` fails the turn, attempt records failure | runtime timeout ≠ human wait |
| S18: process dies mid-turn → respawn resumes same attempt from checkpoint | CLI loss recovery, same attempt, bounded restart |
| S18b: a process that keeps dying exhausts restarts → `cli_lost` failure | bounded restarts, honest terminal failure |
| S19: question records carry channel+dialog evidence on both transports | durable `{channel, dialog:{requestId,method,options}}` on dialog; `{channel:'prompt'}` on post-turn |

### Regression — unchanged acceptance suites, same commands

```
node --test scripts/test_preparation_binding.mjs    → 18/18 pass  (  183ms)  P0
node --test scripts/test_preparation_state.mjs      → 11/11 pass  ( 1213ms)  P1
node --test scripts/test_preparation_skills.mjs     → 23/23 pass  (  998ms)  P2
node --test scripts/test_execution_ui.mjs           → 53/53 pass  ( 4922ms)
node --test scripts/test_fusion_controller.mjs      → 11/11 pass  ( 3745ms)
node --test scripts/test_fusion_handoff.mjs         →  8/8  pass  (11468ms)
node --test scripts/test_execution_environment.mjs  →  1/1  pass  (  235ms)
node --test scripts/test_sfc_loader.mjs             →  1/1  pass  (  112ms)
node --test scripts/test_ui_store.mjs               →  3/3  pass  (  418ms)
node --test scripts/test_workflow_porch.mjs         → 51/51 pass  (  157ms)
node --test scripts/test_ws_transport.mjs           →  1/1  pass  ( 1105ms)
```

### Registry/manifest evidence (real production registry, no spawn)

- `node scripts/preparation_binding_probe.mjs verify all` →
  `/tmp/idea-p3-evidence/verify-all.json` — all 12 manifests re-hash clean
  (digests match the P0/P2 pins; provider sources untouched).
- `node scripts/preparation_binding_probe.mjs audit all` →
  `/tmp/idea-p3-evidence/audit-all.json` — 12/12 `ok:true`.
- `node scripts/preparation_binding_probe.mjs preflight all` →
  `/tmp/idea-p3-evidence/preflight-all.jsonl` — 6 available bindings resolve
  `{adapterId, digest, configDigest, capabilities, gateContract, result}`;
  6 unsupported refuse `route_unsupported` with named reasons (exit 1 by
  design, identical to P2).
- `node --check` on `lead.mjs`, `pi-rpc.mjs`, `session.mjs`, `adapters.mjs`,
  `registry.mjs`, `internal-transport.mjs`, `execution-domain.mjs`,
  `fake-pi-rpc.mjs`, `test_preparation_lead.mjs` — all clean.

## не измерено

- **No live `pi` spawn under P3.** `pi-rpc.mjs` is the real transport (spawn,
  NDJSON, request correlation, containment env, bounded tails) and is
  exercised through its *interface* by the fake in all 23 tests; an
  end-to-end `pi --mode rpc` run driven by `lead.mjs` against a real skill
  is a bounded follow-up probe, not done here (P3's plan section allows
  deterministic transport fakes).
- **No production service / compose run.** The seams were exercised through
  `createStateService`'s real request + `internalCommand` surfaces in-process
  (`serviceFromService`) and the runner-side `serviceFromClient` client was
  added but is unwired until the runner hosts the lead (P4+/ops wiring).
- **Cross-attempt `newAnswers` are checkpoint-carried, not per-attempt
  filtered.** The "answers since your last turn" section lists answers bound
  to the current attempt; answers recorded on superseded attempts still
  reach the discussion through the full durable question/decision sections
  of every prompt — intent is preserved, the *delta* section is per-attempt.
- **Process reuse waits on `planKey` equality.** Any plan field change
  (binding, stage, tools, roots) respawns under the same `--name` — that is
  deliberate (a different plan on a reused process would inherit stale
  tools/skills); the discussion identity survives because Pi resumes the
  named session.
- P4/P5 scopes (handoff dispatch into route transitions, document/approval
  gate surfacing, UI, e2e) are untouched and unmeasured.

## Известные разрывы / P4 dependency

- **Runner wiring is a client, not a host.** `lead.mjs` ships
  `serviceFromClient` for the runner's authenticated internal transport; a
  runner-side supervisor that calls `lead.drive(cardId)` on card events and
  `lead.stop(cardId)` on stop is the P4/ops integration point — the driver
  itself is complete and tested against the production state-service seam.
- **`blocked` sessions stay visible, not auto-retried.** A `blocked` attempt
  exposes `session.blocker` in the view; resume is an explicit user/command
  action (`continue_discussion`), which P4's flow already provides.
- **`host_choice` handoffs remain evidence-only** (P2 decision unchanged) —
  dispatch happens only through `change_skill_binding`.
- The `unsupported: null` registry tolerance added for S15b is compatible
  with P0–P2: `loadRegistry` still validates `unsupported` objects strictly
  when present.

P3 ГОТОВ
