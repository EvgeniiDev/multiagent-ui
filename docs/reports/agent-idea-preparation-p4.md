# P4 — Idea Preparation: требования, дизайн, план и передача

Date: 2026-10-03. Branch `feat/agent-modes`. Author: Devin (SWE-2 Max), single executor.
Scope: **only** P4 of `docs/plans/agent-idea-preparation-plan.md` lines 123–129
(R1, R4–R7, R11; KTD6–KTD8). P0/P1/P2/P3 are dependencies — containment (P0),
session/checkpoint/gates (P1), binding contracts (P2), the lead driver (P3)
are reused in place. No P5 UI/browser work, no Fusion/Orchestrator/Swarm
dispatch implementation, no `src/`, compose, installed-plugin, or
provider/upstream edits, no commits.

## STATUS: DONE

## вывод

P4 closes the preparation **result → package → offer** loop. The durable
contract that existed in pieces is now enforced end-to-end:

- **No plan without accepted requirements — on BOTH sides of the seam**
  (`session.mjs`). `request_draft {kind:'plan'}` refuses 422
  `requirements_unapproved` unless an approved requirements version is
  current — the session will not even mint the attempt. The `prep_result`
  import path (`attachSessionDocument`) refuses a plan document the same
  way when requirements are unapproved, and binds every imported plan to the
  **approved** requirements `{versionId, sha256}` — never to a merely
  attached current one. An explicit `requirementsVersionId` naming anything
  but the approved version is refused 409 `plan_binding_stale`, not silently
  rebound. The generic core `attach_document` keeps its pre-existing
  contract (binds plan→current requirements; `approve_plan` already refuses
  `plan_binding_stale` unless the bound version is the approved one) — the
  stricter no-mint rule applies to the *preparation* produce/import seams,
  which is what the plan's «не выдавать план реализации без принятой версии
  требований» governs.
- **Immutable provenance kept honest** (`session.mjs`). Session-imported
  versions keep `{type:'preparation', sessionId, attemptId}` source records,
  `meta.intentSha256` (the restatement the doc was produced under), and
  `meta.{bindingId, bindingDigest, bindingConfigDigest}` for contract-bound
  routes; the `applied.document` result now echoes a plan's exact
  `requirements` binding as import evidence, and `presented[kind]` carries
  `sourceType` ('preparation'/'text'/'work_order') so the provenance of the
  pointed-at version is one field, not an archive lookup.
- **Completeness as data, not a verdict** (`session.mjs` `completenessView`
  on the view). Per-kind `absent/presented/draft/approved` (design:
  `confirmed` — derived only from a gate record confirmed against the
  PRESENTED version; design has no core approval by plan) plus
  `assumptions`/`decisions`/`openQuestions{open,blocking,answered,deferred}`
  counters from the checkpoint. R4/R5: design remains optional — a session
  without a design stage reads `absent` and reaches `ready`; when a design
  is present its own version and its real artifact gate are what close it.
  Approvals are never relabeled as gate confirmations.
- **Handoff = durable offer, never a dispatch** (`handoff_preparation`,
  new user command + `session.handoffs[]` + `view.handoffs/handoffTargets/
  package`). Recording an offer requires `evaluateReadiness({verify:true})`
  — the same full gate the implementation `start` re-proves (registry
  digests + filesystem manifest re-verify). The record freezes
  `inputs{requirements,plan{…,checks},design,intentSha256}` plus
  `context{restatement,decisions,assumptions,openQuestions}` — the package a
  downstream mode would need **without a new interview** (KTD8). Modes are
  `solo|fusion|orchestrator|swarm`; `implemented` is honest (`solo`/`fusion`
  true, `orchestrator`/`swarm` false — the offer is a package waiting for a
  consumer that does not exist yet, never a capability claim). The same
  mode+inputs re-offer is `reused:true`; a changed input marks every record
  `stale` in the view and a fresh offer supersedes the old one; replays are
  dedup-idempotent. Nothing mints a run, an attempt, or a mode call —
  implementation still starts only through core `start`/`continue`, which
  re-checks approvals **and** `prepAssertStartReady` in the same commit.
- **Fusion return stays a new unapproved version** — the existing
  `work_order` source already verifies the artifact hash and mints a fresh
  DocumentVersion; P4 asserts the session presents it (`sourceType:
  'work_order'`) with approvals untouched and readiness still owed.

Design choices kept minimal: handoff offers live **on the session** (a
package is meaningful only inside a preparation session; the view derives
`stale` from `handoff.inputs` vs the current accepted basis — no parallel
approval authority was created, core approvals remain the only acceptance).

## Files changed (this work only)

| File | Kind | Contents |
|---|---|---|
| `server/execution/preparation/session.mjs` | modified | `attachSessionDocument`: plan requires approved-current requirements; explicit `requirementsVersionId` ≠ approved → `plan_binding_stale`. `cmdRequestDraft`: plan drafts gated the same way (no attempt minted). `presentVersion` + adopted-entry: `sourceType`. `session.handoffs[]` at creation. New `handoff_preparation` user command (`HANDOFF_MODES`, `HANDOFF_IMPLEMENTED`, `handoffInputs/handoffContext/handoffView`, dedup `reused`, supersede-on-input-change, `evaluateReadiness({verify:true})` gate). `completenessView` + `handoffTargets`/`handoffs{…,stale}`/`package` on `preparationView`; `handoffs` count on `preparationSummary`. `applied.document` echoes plan `requirements` binding. `PREP_COMMANDS`/`PREP_HANDLERS` + header updated |
| `server/execution/execution-domain.mjs` | modified | `handoff_preparation` case in the PREP dispatch branch |
| `scripts/test_preparation_handoff.mjs` | **new** (~1400 lines) | 9 node:test cases — the P4 scenario map below; real `createStateService` queue, `internalCommand` seam, `loadAggregate`, `verifyManifest`, `buildManifest`; deterministic tmpfs registry; minimal F3-style container runtime + `createManagedScheduler` for the Fusion drive; `faults.docNames` crash injection |
| `scripts/test_preparation_lead.mjs` | modified | S15c seeds an attached+approved requirements version before `request_draft {kind:'plan'}` — the new produce-side gate made the old fixture illegal (its purpose, workspace-artifact import/dropped-claim, is unchanged) |
| `docs/reports/agent-idea-preparation-p4.md` | **new** | this report |

## измерено

All runs on this checkout, this session. `node --test` bare runner; no
services started, no ports touched, no network, no compose.

### P4 suite — `node --test scripts/test_preparation_handoff.mjs`

```
ℹ tests 9   ℹ pass 9   ℹ fail 0   ℹ duration_ms ~1700–1955   exit 0
```

| Test | Plan scenario (line 129) |
|---|---|
| P4-S1 | AE1 малая задача: requirements → plan via `prep_result`, no design stage → `ready`; provenance meta (`source.type='preparation'`, `intentSha256`, `bindingId`+digests) asserted on the stored version; `package` exposes pinned inputs + `checks` |
| P4-S2 | AE2 сложная: kickoff questions/decisions/assumptions → answer → requirements → design (its own gate) → plan; `checkpoint` preserves the answered question verbatim; `package.context` carries restatement/decisions/assumptions/answers — no new interview |
| P4-S3 | plan binding: `request_draft plan` before acceptance → 422 `requirements_unapproved` (no attempt minted); a kickoff result returning a plan → 422, zero versions minted; merely-attached requirements still refuse; after acceptance the draft binds `{versionId,sha256}` verbatim; `requirementsVersionId:'v_…'` → 409 `plan_binding_stale`; explicit approved pin binds exactly |
| P4-S4 | drafts/prior versions: draft presented → `start` 422 (core gate); v2 requirements import revokes both approvals → start refuses; re-approve v1 → 409 `stale_version`; v1-bound plan → 422 then 409 `plan_binding_stale` under v2; fresh v2-bound plan + re-confirmed gates → ready |
| P4-S5 | approvals ≠ gates: all approvals in place, 4 `gate_pending` blockers → `start` 422 `preparation_not_ready`; design gate binds the EXACT presented design `{versionId,sha256}`; intent gate binds the current restatement hash |
| P4-S6 | AE3: restatement invalidates intent+3 artifact gates, approvals stand → `start` 422; `reaffirm` + per-gate reconfirm → ready; binding digest drift → `binding_digest_changed` on that binding only; `change_skill_binding` repin mints a FRESH pending gate — the old confirmation is not inherited |
| P4-S7 | handoff: pre-ready → 422 `preparation_not_ready`; bad mode → 422; all four modes recorded with frozen `inputs`+`context`, `implemented` flags honest (solo/fusion ✓, orchestrator/swarm ✗); `runs.length===0` and zero running attempts after offers; `reused:true` on same inputs; commandId replay idempotent; input change → all records `stale`, `package:null`; fresh offer supersedes; `start` still mints the run through the core seam |
| P4-S8 | Fusion return: document run driven to `blocked` work-order via the fake container runtime + `createManagedScheduler` → `approve_work_order` → `succeeded`, NO approval minted, NO version minted; `attach_document {source:{type:'work_order'}}` → NEW version, `source.sha256===wo.sha256`, blob bytes hash to the WO artifact, `presented.requirements.sourceType='work_order'`, still unapproved + `requirements_unapproved` blocker |
| P4-S9 | crash/idempotency: armed `board.json` fault on `prep_result` → 500 after commit; durable version+presented pointer+terminal attempt+journaled `board_projection` intent verified; restart repairs; identical replay → `idempotent:true`, different payload same commandId → 409 `command_conflict`, still 1 version; same boundary on `handoff_preparation` → durable `handoffs[]` record, restart, replay returns the recorded offer |

### Regression — unchanged acceptance suites, same commands

```
node --test scripts/test_preparation_binding.mjs    → 18/18 pass  (~180ms)   P0
node --test scripts/test_preparation_state.mjs      → 11/11 pass  (~1146ms)  P1
node --test scripts/test_preparation_skills.mjs     → 23/23 pass  (~972ms)   P2
node --test scripts/test_preparation_lead.mjs       → 23/23 pass  (~2301ms)  P3
node --test scripts/test_preparation_handoff.mjs    →  9/9  pass  (~1747ms)  P4
node --test scripts/test_execution_ui.mjs           → 53/53 pass
node --test scripts/test_fusion_controller.mjs      → 11/11 pass
node --test scripts/test_fusion_handoff.mjs         →  8/8  pass
node --test scripts/test_execution_environment.mjs  →  1/1  pass
node --test scripts/test_sfc_loader.mjs             →  1/1  pass
node --test scripts/test_ui_store.mjs               →  3/3  pass
node --test scripts/test_workflow_porch.mjs         → 51/51 pass
node --test scripts/test_ws_transport.mjs           →  1/1  pass
```

Combined runs (exact commands, evidence in `/tmp/p4-evidence/`):

```
node --test scripts/test_preparation_handoff.mjs
  → exit 0, 9/9,  duration_ms 1746.8   (p4-suite.txt)
node --test scripts/test_preparation_binding.mjs scripts/test_preparation_state.mjs \
              scripts/test_preparation_skills.mjs scripts/test_preparation_lead.mjs
  → exit 0, 75/75, duration_ms 2543.9  (p0-p3-suite.txt)
node --test scripts/test_execution_ui.mjs scripts/test_fusion_controller.mjs \
              scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs \
              scripts/test_sfc_loader.mjs scripts/test_ui_store.mjs \
              scripts/test_workflow_porch.mjs scripts/test_ws_transport.mjs
  → exit 0, 129/129, duration_ms 11340.1 (regression.txt)
```

### Registry/manifest + build evidence

- `node scripts/preparation_binding_probe.mjs verify all` → exit 0,
  12/12 `ok:true` (`/tmp/p4-evidence/verify-all.json`) — production skill
  resources re-hash to the pinned digests; provider sources untouched.
- `node scripts/preparation_binding_probe.mjs audit all` → exit 0,
  12/12 `ok:true` (`/tmp/p4-evidence/audit-all.json`).
- `npm run build:web` → exit 0, Vite 6.4.1 built (same existing >500 kB
  chunk warning as the accepted baseline; `src/` untouched).
- `node --check` clean on `session.mjs`, `execution-domain.mjs`,
  `test_preparation_lead.mjs`, `test_preparation_handoff.mjs`.

### Baseline delta

`git status --short` vs `/tmp/idea-p4-baseline-20261002.txt` (114 entries,
sha256 `1d9e2df7…d40a`) — three new entries, enumerated completely:

| Entry | Author |
|---|---|
| `?? BRIEF_IDEA_P4.md` | orchestrator brief artifact, appeared mid-run — not this work |
| `?? docs/reports/agent-idea-preparation-manager-acceptance.md` | manager acceptance artifact — not this work |
| `?? scripts/test_preparation_handoff.mjs` | **this work** (new P4 suite) |

Plus `?? docs/reports/agent-idea-preparation-p4.md` (this report) on write.
The **content** changes inside already-untracked baseline files —
`server/execution/preparation/session.mjs`,
`server/execution/execution-domain.mjs`, `scripts/test_preparation_lead.mjs`
— are enumerated in "Files changed" because a path-list comparison cannot
show byte differences; no tracked file was modified by this work, and no
baseline entry was deleted or overwritten.

## не измерено

- **No live `pi` lead-driver run — inherited P3 gap, unchanged.** The P4
  import path is driven through the durable `prep_result`/`prep_question`
  internal seams (the exact contract `lead.mjs` consumes), and the lead
  suite's plan-draft test now seeds approvals — but no end-to-end Pi
  process produced these documents. Honest statement: P4 proves the
  durable-side contract, not the transport.
- **Runner hosting still unwired — inherited P3 gap, unchanged.**
  `serviceFromClient` remains a client; no runner-side supervisor drives
  `lead.drive()` on card events.
- **No dispatch behind the handoff offers — by design.** `implemented`
  marks solo/fusion only; orchestrator/Swarm offers are packages awaiting a
  consumer. P4 measured the offer + staleness/idempotency contract, not a
  mode launch — the real solo start is asserted separately (`P4-S7` tail)
  through the unchanged core `start` gate.
- **No production compose/service run, no browser P5** (out of scope).
- **No P0 live-Pi symlink smoke re-run** — P0 code untouched; the
  12/12 verify/audit evidence above is the integrity gate this run needs.

## Integration requests

- **Runner/ops**: host the preparation lead — call `lead.drive(cardId)`
  (from `serviceFromService`/`serviceFromClient`, both existing) on session
  events and `lead.stop(cardId)` on `stop_preparation`. The durable side
  (attempts, `prep_result`, CAS dedup) needs no further work.
- **P5**: surface `view.completeness`, `view.handoffTargets`,
  `view.handoffs{…,stale}`, `view.package`, and `summary.handoffs` in the
  card drawer/chat; `handoff_preparation {mode, note?, by?}` is a normal
  user command on the existing CAS seam.
- **Orchestrator/Swarm**: consumers read `view.handoffs`/`view.package`
  (or the durable `aggregate.preparation.handoffs`) — the frozen
  `inputs`+`context` record IS the handoff contract; flip
  `HANDOFF_IMPLEMENTED` when a real dispatcher lands.

## Remaining runtime gaps (honest list)

1. Live `pi` lead-driver turn against a real binding — P3 carry-over.
2. Runner-side lead supervisor — P3 carry-over.
3. Orchestrator/Swarm consumers — no dispatcher exists anywhere yet;
   handoff records for them are evidence, flagged `implemented:false`.
4. `attach_document` (core, non-session) may still mint a plan version
   before requirements are *approved* — it binds current requirements and
   `approve_plan` refuses unless the bound version is the approved one.
   The stricter no-produce/no-accept rule holds on the preparation seams
   (`request_draft`, `prep_result`) per the P4 scope; tightening the
   generic core seam for session-active cards would change the
   `attach_document` contract used by non-preparation flows — deliberately
   left as is, flagged for review if the boundary should move.

P4 ГОТОВ
