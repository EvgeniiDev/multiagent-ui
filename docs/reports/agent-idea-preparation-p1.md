# P1 — Idea Preparation: session/state and phase transitions

Date: 2026-10-03. Branch `feat/agent-modes`. Author: Devin (SWE-2 Max), single executor.
Scope: **only** P1 of `docs/plans/agent-idea-preparation-plan.md` (plan lines 99–105; R1–R7, R10–R11, KTD1/KTD6/KTD8). P0 (`docs/reports/agent-idea-preparation-p0.md`) is a dependency — its registry, `assertRouteAvailable`, `verifyManifest`, `buildManifest` are reused verbatim; no P0 file was modified. No P2/P3/P5, no UI/`src/`, no compose/production changes.

## STATUS: DONE

## вывод

P1 delivers a durable, fail-closed preparation layer inside the serialized execution
queue — no second approval authority, no chat-text authorization:

- **PreparationSession** (one active per card; stopped sessions archived to
  `preparationHistory`, cap 5) with phases `clarify → requirements → design →
  plan → ready` derived, never asserted. The kickoff lead attempt is minted in
  the same commit as the session — a durable anchor before any result can land.
- **Idempotent commands** on the existing durable command ledger: same
  `commandId`+payload replays the recorded outcome; a changed payload conflicts.
  `start_preparation` with the same intent and no contradictory binding reuses
  the live session (tab-equivalent safe); a different intent returns 409
  `preparation_active`.
- **Document-to-phase binding**: every presented requirements/design/plan
  version is recorded on the session (`versionId`, `sha256`, provenance,
  `draft`, `intentSha256`) via `attach_document` and the internal `prep_result`
  seam. New versions invalidate only dependent confirmed gates; core approval
  revocation rules are unchanged.
- **SkillGate** records bind `{bindingId, resource digest, gate type, subject —
  document versionId+sha256 or intent-restatement sha256, explicit
  confirm_gate user action}`. `start_preparation`/`change_skill_binding` route
  selection calls P0 `assertRouteAvailable` — unsupported/candidate bindings
  refuse 422 `route_unsupported`/`route_unproven` before anything persists.
- **Readiness is derived** from approved+current requirements and plan (the
  unchanged core lifecycle), every required gate of the bindings actually used
  confirmed against a still-current subject, presented artifacts produced under
  the current intent, and zero unresolved blocking questions. A lead's last
  message, attempt completion, or model confidence contributes nothing.
- **Start gate**: `requireApprovedInputs` (used by `start` and `continue`)
  additionally calls `prepAssertStartReady` when an ACTIVE session exists —
  full `evaluateReadiness` with `verify: true` revalidates binding status,
  pinned digest, and the full resource manifest (P0 `verifyManifest`) in the
  same commit that would mint the run. A stopped/absent session gates nothing —
  the card returns to the plain core lifecycle, whose approvals still bind.
- **Crash consistency**: commands journal `pendingWrites` intents before
  flushing; a crash between the aggregate commit and the board-projection
  flush is repaired on the next op/restart from aggregate truth — never
  phantom-ready, never lost.

## Files changed (this work only)

| File | Kind | Contents |
|---|---|---|
| `server/execution/preparation/session.mjs` | **new** (1546 lines) | P1 domain module: session lifecycle, phase derivation, checkpoint, attempts, SkillGates, readiness eval, all 7 user commands + `prep_result`, view/summary helpers |
| `server/execution/execution-domain.mjs` | modified (baseline-untracked file) | imports; `PREP_COMMANDS`→COMMANDS, `prep_result`→INTERNAL_COMMANDS; `PREPARATION_GATED`/`PREPARATION_INTERNAL` feature checks; `PREP_DEPS` deps bag; dispatch cases; `prepAfterAttach` + `prepAfterRequirementsChanged` hooks; `prepAssertStartReady` inside `requireApprovedInputs`; `'preparation'` server-owned board field; `preparation: null`/`preparationHistory: []` on new aggregates; `preparationSummary` in `computeProjection` |
| `server/execution/state-service.mjs` | modified | `fileURLToPath` import; `featureFlags.preparation` (`features.preparation===true` or `ACP_EXEC_PREPARATION=1`); `prepRegistryPath` resolution (`options.preparation.registryPath` → `ACP_PREP_REGISTRY` → bundled P0 `bindings.json`); ctx seams `preparationRegistry`/`preparationVerify` (fresh load per op); `cardView.preparation` summary; `handleGetPreparation` + `GET /api/execution/cards/:cardId/preparation`; fault sets kept by reference (`docNames` same mechanism as `runs`/`runEvents`) so tests can arm/disarm a crash window |
| `scripts/test_preparation_state.mjs` | **new** (~1150 lines) | 11 node:test cases — all 8 required scenarios through the production `createStateService` request surface + `internalCommand` seam, real fault seams, a real registry built by P0 `buildManifest`, lead turns via `createFakeRuntime` |
| `docs/reports/agent-idea-preparation-p1.md` | **new** | this report |

Baseline dirt preserved: `git status` = 91 untracked + 16 modified — the only
entries added by this work are the three new files above
(`server/execution/preparation/session.mjs` inside the already-untracked
`preparation/` dir, `scripts/test_preparation_state.mjs`, this report);
**zero tracked files modified** (the whole `server/execution/` tree is
untracked baseline; all ` M` entries pre-date this work).
`git diff --check` on the touched files: clean.

## API surface (minimal state-server wiring)

- `GET /api/execution/cards/:cardId/preparation` — inside the write queue;
  404 `card_not_found` for unmanaged cards; 501 `unavailable` when the feature
  is off; 200 `{cardId, controlRevision, preparation}` otherwise — session,
  phase, ready/blockers, bindings, presented artifacts, gates, attempts,
  checkpoint (decisions/assumptions/openQuestions/log tail). Read-only:
  aggregates/boards/documents byte-identical across reads (S3).
- User commands (each requires `commandId` + `expectedControlRevision`):
  `start_preparation {intent, bindings?, discussionRef?}`,
  `answer_question {questionId, answer, intent.restate?, defer?}`,
  `request_draft {kind, note?}`,
  `continue_discussion {text?, intent.restate?, reaffirm?, defer?, decisions?}`,
  `stop_preparation {reason?}`,
  `change_skill_binding {stage, bindingId|null}`,
  `confirm_gate {gateId, by?}`.
- Internal command (service-side `internalCommand` channel only — never
  routed over HTTP): `prep_result {attemptId, result}` — the durable seam the
  P3 lead driver will consume.

## измерено

All runs on this checkout, this session. `node --test` is a bare test runner —
no services were started, no ports touched (compose state unchanged).

### Focused suite — `node --test scripts/test_preparation_state.mjs`

```
✔ S1  concurrent + repeated start_preparation produce one durable session   (~87ms)
✔ S2  hash-bound approvals refuse mismatches; never replay onto newer      (~79ms)
✔ S3  status/read-only queries leave aggregate, board, documents untouched (~66ms)
✔ S4  intent restatement invalidates dependent gates; reaffirm+re-confirm (~135ms)
✔ S5  draft with blocking open questions stays blocked                    (~99ms)
✔ S6  crash after aggregate commit, before board flush, heals on restart   (~51ms)
✔ S7  cancelled attempts/late results refused; replays idempotent         (~142ms)
✔ S8  unsupported/candidate/unknown bindings + gate violations fail closed (~99ms)
✔ S8b registry repin → stale digest; drifted resources fail at start gate (~111ms)
✔     plain lead path: zero-binding session gated on approvals only        (~72ms)
✔     feature gate: prep commands 501 when disabled; prep_result not on    (~42ms)
      the user channel
tests 11 · pass 11 · fail 0 · ~1.1s total
```

### Required scenarios → evidence

| # | Scenario | Test / evidence |
|---|---|---|
| 1 | Concurrent/tab-equivalent start → one session; repeats idempotent | **S1**: two in-flight `start_preparation` with the same `commandId`+revision → same `sessionId`, one marked `idempotent:true`; same intent different `commandId` → `reused:true`; different intent → 409 `preparation_active`; same `commandId`+different payload → 409 `command_conflict` |
| 2 | Version/hash-bound acceptances can't replay onto another version; core lifecycle unchanged | **S2**: `approve_requirements`/`approve_plan` with wrong `versionId`/`sha256` → `approval_mismatch`-class refusal; approving v1 then attaching v2 revokes; re-approving v1's hash against current v2 refuses. No lifecycle code was touched — approval commands dispatch to the unchanged `cmdApproveRequirements`/`cmdApprovePlan` |
| 3 | Status/read-only queries alter nothing | **S3**: `GET /preparation`, `GET /cards/:id`, `GET /documents/:versionId`, `GET /api/state/board.json` ×2 each → aggregate file **byte-identical**, board `rev` unchanged, `controlRevision`/`internalRevision`/`commandsProcessed` unchanged. A conversational status ask (`continue_discussion{text}`) records a turn but leaves `documents`, `approvals`, `gates`, and presented `versionId`/`sha256` deep-equal |
| 4 | Intent change invalidates dependent plan/gates, never falsely accepts a replacement | **S4**: ready session → `continue_discussion {intent.restate}` → intent gate + both confirmed artifact gates (produced under the superseded restatement) invalidated (`intent_changed`, ≥3 gate ids); `artifact_stale` + `gate_reconfirm` blockers; core approvals stand (documents unchanged); `start` → 422 `preparation_not_ready`; `reaffirm` re-anchors docs then `confirm_gate` re-confirms → `ready`; identical restatement is a no-op (`intentChanged:false`). Dependent-only invalidation is also proven in **S8** — a requirements document change invalidates requirements+plan gates while the intent gate stays `confirmed` |
| 5 | Early draft preserves open questions; assistant end ≠ ready | **S5**: `prep_result` delivers `draft:true` document + blocking open questions → version lands, `presented.draft` set, `open_questions` blocker; turn "completed" changes nothing; `defer` of a non-blocking question + `answer_question` of the blocking one (same-answer replay → `alreadyAnswered:true`, different answer → 409 `question_closed`) clears the blocker |
| 6 | Crash between durable document write and projection update recovers or stays safely blocked | **S6**: `faults.docNames` armed for `board.json` → `attach_document` returns 500 EINJECT **after** aggregate commit — durable truth holds the version, presented pointer, command record (status 200), journaled `board_projection` intent; blob on disk; board `rev` unmoved. Fresh `createStateService` on the same `stateDir` repairs; command replay returns the identical recorded outcome (`idempotent:true`); view consistent and **not** ready (`gate_pending`); healed board carries the `preparation` row |
| 7 | Stopping an answer/attempt can't replace or authorize a newer document/attempt; retries idempotent | **S7**: superseded kickoff's late doc result → `applied:false, attempt_cancelled`, zero versions minted; duplicate result on a terminal attempt → `attempt_terminal`; same `commandId` replay → `idempotent:true`; parked question on a superseded turn → `answer_question` → 409 `stale_attempt`, question record preserved; `stop_preparation` cancels live attempts, late doc → `session_stopped`, double-stop `alreadyStopped:true`; restart archives to `preparationHistory` (evidence kept), archived attempt's result → `attempt_unknown` |
| 8 | Missing/stale/changed/unsupported SkillGate paths fail closed with structured results | **S8**: unsupported binding → 422 `route_unsupported` + `reason`; candidate → `route_unproven`; unknown id → `unknown_binding`; confirm of a non-minted/wrong-subject gate → `gate_unknown`/`gate_subject_absent`; `start` with pending gate → `preparation_not_ready{blockers:[gate_pending]}`. **S8b**: registry repin → `binding_digest_changed` (GET view) + `gate_digest_stale` (confirm) + `preparation_not_ready` (start); `change_skill_binding` re-pins → old gate invalidated, fresh pending minted; file drift under a pinned digest passes the read but fails `verifyManifest` at the start gate → `binding_resources_drifted`; restore → real `start` mints a run |

### Regression suites

| Command | Result |
|---|---|
| `node --test scripts/test_preparation_state.mjs` | **11/11** (~1.1s) |
| `node --test scripts/test_preparation_binding.mjs` (P0) | **18/18** (~188ms) |
| `node scripts/preparation_binding_probe.mjs verify all` | **12/12** manifests ok |
| `node scripts/preparation_binding_probe.mjs audit all` | **12/12** ok |
| `node --test scripts/test_execution_ui.mjs` (incl. real state-service handler contract) | **53/53** (~4.9s) |
| `node --test scripts/test_fusion_controller.mjs scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs` | **20/20** (~10.4s; env file prints 82/82 checks) |
| `node --check` on all four touched `.mjs` files | clean |
| `git diff --check` on touched files | clean |

## не измерено

- **Design-stage path**: `documents.design`/`presented.design` + `design` gate
  contract are implemented and flow through the same machinery, but no test
  drives a `design`-stage binding end-to-end (R5 keeps design optional — the
  basic path never requires it).
- **Document adoption** (R6 continuity): `start_preparation` adopts the card's
  existing current versions as `presented` under the initial intent —
  implemented; no dedicated assertion on `via:'adopted'` provenance.
- **`session.discussion`**: bound from `aggregate.session` or
  `payload.discussionRef`; the real chat binding is P3/P5.
- **Lead transport**: `prep_result` is the durable seam; the actual pi/RPC
  lead driver (question↔`extension_ui_response` matching, prompt composition)
  is P3 — tests simulate it through `createFakeRuntime` runs.
- **Repair classes beyond `board_projection`**: preparation only ever stages
  board-projection intents; other intent kinds' crash windows are unchanged
  core behavior.
- **`npm run build:web`**: not run — nothing under `src/` was touched
  (server-only change).
- No P0-owned file modified (`registry.mjs`, `bindings.json`, bridge, probe)
  — `verify all`/`audit all` = 12/12 on the pristine registry.

## Known gaps / deliberate limits

- `GET /preparation` readiness compares registry digests but does **not**
  re-hash skill files (`verify:false`) — the filesystem re-verify is reserved
  for the implementation start gate; S8b proves the drift still fails closed
  there. Reads never write.
- `GET /preparation` on a managed card with no session returns 200 with
  `preparation: null` (consistent with `cardView`), not 404.
- Gate contracts are derived from binding **stage** with an explicit
  `GATE_CONTRACT_OVERRIDES` map (`ce-doc-review` → no user gate). P2 should
  move this to a declared field on the binding (comment marks the seam).
- `preparationHistory` caps at 5 archived sessions; checkpoint log caps at
  400 entries (`droppedLog` counted, never silently lost).
- `confirm_gate` binds the subject presented at **confirmation** time —
  re-confirming an already-confirmed gate whose subject is unchanged is
  idempotent (`alreadyConfirmed:true`).

## Next P2 dependency

P2 (SkillBinding/compat) consumes from this unit:

- `session.bindings[stage]` refs `{bindingId, stage, digest, adapterVersion,
  questionChannel, assignedAt}` + `change_skill_binding` semantics (incl.
  same-id re-pin → `binding_repinned` invalidation);
- ctx seams `ctx.preparationRegistry()` / `ctx.preparationVerify(binding)`
  supplied by state-service (fresh load per op — P2's runtime repin/migration
  checks plug in here);
- `mintGatesForBinding`/`requiredGatesFor` — replace the stage-derived contract
  (+ overrides map) with the declared per-binding gate contract;
- `resolveBindingRef` — the P0 `assertRouteAvailable` call site where P2
  capability preflight extends;
- `PREP_DEPS` bag and the `prep_result` durable seam P3's lead driver fills.
