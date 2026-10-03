# P2 — Idea Preparation: SkillBinding and compatibility

Date: 2026-10-03. Branch `feat/agent-modes`. Author: Devin (SWE-2 Max), single executor.
Scope: **only** P2 of `docs/plans/agent-idea-preparation-plan.md` (KTD3–KTD7,
P2 acceptance scenarios). P0 (`docs/reports/agent-idea-preparation-p0.md`) and
P1 (`docs/reports/agent-idea-preparation-p1.md`) are dependencies — registry,
manifest pin/verify, route guard, session/gate/phase machinery are reused and
extended in place. No P3–P5, no Fusion/Orchestrator/Swarm, no UI/`src/`, no
compose/production changes, no provider/upstream edits, no target-project writes.

## STATUS: DONE

## вывод

P2 turns a SkillBinding from a pin + route entry into a **declared runtime
contract**, and wires that contract through assignment, session versioning,
result intake, and planning:

- **Declared contracts on the binding** (`bindings.json`, all 12 entries):
  `adapterId`, `adapterVersion`, `requires[]`, `gateContract[]`, `result{}`.
  An `available` binding that omits `gateContract`/`result` fails registry
  load (`invalid_registry`) — a route that cannot describe its contract
  cannot serve it. `gateContract: []` is a real declaration (no user gate),
  distinguishable from an absent contract (P1 stage-derived fallback for
  legacy binding refs). Handoff targets must resolve to registered bindings
  at load — a dangling route-to-nowhere refuses. `docKind` must equal the
  binding's own stage when a document is imported.
- **Capability preflight** (`preflight.mjs`) runs at *assignment* time inside
  `start_preparation`/`change_skill_binding` — before any ref, gate, or
  attempt exists: route truth → adapter resolution → adapter compatibility
  (`adapter_version_unsupported`, `adapter_unsafe`) → required-vs-host
  capabilities (`capability_missing` with `{missing, required}`) → pinned
  manifest presence (`resources_unpinned`) → gate-contract well-formedness.
  `preflightBinding` layers the filesystem truth (`verifyManifest` re-hash +
  declared-root existence) for the probe/evidence path.
- **Two version identities, both snapshotted on the session binding ref**:
  `digest` (pinned resource set, P0 manifest) and `configDigest` (SHA-256
  over canonical-JSON of the runtime contract — adapter id/version, provider,
  question channel, tools, requires, gate/result contracts, skill names,
  roots, resource paths). A resource repin surfaces `binding_digest_changed`;
  a contract edit with untouched resources surfaces `binding_config_changed`;
  `change_skill_binding` with the same id is the explicit migration — the
  checkpoint (questions/decisions/log/presented docs) is retained verbatim,
  dependent gates invalidate (`binding_repinned`/`binding_reconfigured`), a
  fresh gate set mints under the new snapshot, and a `binding_migrated`
  event records both digests. Nothing is silently absorbed.
- **Result containment** (KTD6): `prep_result` and `translateResult` share
  one whitelist — `note/questions/decisions/assumptions/document/proposal/
  handoff`. Any other channel (`commands`, `api`, `toolCalls`, `exec`,
  arbitrary keys), including keys smuggled inside `document`/`proposal`/
  `handoff`, refuses the whole result 422 `result_channel_unsupported` with
  `offending[]` — never executed, never silently dropped. Documents enforce
  the stage binding's declared `result` contract (`result_off_contract` on
  `importAs:none` delivery, docKind mismatch); draft attempts are
  contract-bound to their minted `docKind`. Handoffs are evidence only:
  undeclared → refused; declared → recorded (`handoff_recorded`) with the
  declared mode (`host_choice`/`recorded`/`denied`), never dispatched.
- **Original resources, provably** (`resources.mjs`): `loadBindingResources`
  re-verifies the manifest, then re-hashes every file as it reads it — the
  bytes served are the pinned bytes. `planInvocation` passes each pinned
  `skillDir` to pi via `--skill` (the provider's own loader reads the
  original SKILL.md); no prompt text is inlined, rewritten, or imitated. The
  P0 probe driver now builds its argv through `planInvocation` — probe
  evidence IS adapter evidence.
- **Adapters** (`adapters.mjs`): registry keyed `pi-skill` (P0-probed
  contract versions `p0-probe-1`/`pi-skill-1`), plus the host seams
  `ctx.preparationCapabilities()` / `ctx.preparationAdapters()` on
  `createStateService` — a descriptor can only shrink what a binding may
  claim, never widen it. Unsupported/candidate routes refuse inside the
  adapter seam too (defense in depth), so a caller that skips preflight
  still cannot plan a refused route.

## Files changed (this work only)

| File | Kind | Contents |
|---|---|---|
| `server/execution/preparation/skills/registry.mjs` | modified | `adapterId`/`requires`/`gateContract[]`/`result{}` schema fields + validators; handoff-target cross-reference; `bindingConfigDigest` (canonical JSON); `available` requires the full contract |
| `server/execution/preparation/skills/capabilities.mjs` | **new** | host capability descriptor + defaults; required/missing capability math; `capability_missing` refusal |
| `server/execution/preparation/skills/adapters.mjs` | **new** | adapter registry; `pi-skill` adapter (compatibility: contract version, question channels, tools, result modes); `planInvocation` (pure argv/env/cwd data — never spawns); `assertResultChannels`/`translateResult` whitelist + contract enforcement |
| `server/execution/preparation/skills/resources.mjs` | **new** | `loadBindingResources` (manifest re-verify + per-file re-hash on read, verbatim text), `resourceSnapshot` |
| `server/execution/preparation/skills/preflight.mjs` | **new** | `resolveGateContract` (declared vs absent vs malformed), `preflightContract` (fs-pure, used at assignment), `preflightBinding` (full: manifest re-hash + root existence) |
| `server/execution/preparation/skills/bindings.json` | modified | declared `adapterId`/`adapterVersion`/`requires`/`gateContract`/`result` on all 12 bindings (unsupported keep the refused-route record, `requires` documents the absent capability) |
| `server/execution/preparation/session.mjs` | modified | assignment-time `preflightContract` + manifest verify inside `resolveBindingRef`; ref snapshots `{digest, configDigest, adapterId, adapterVersion, gateContract, result}`; `binding_config_changed` blocker in `evaluateReadiness`; same-id `change_skill_binding` migration comparing both digests; `binding_migrated`/`binding_reconfigured` events; `confirm_gate` binds `{digest, configDigest}`; `prep_result` channel whitelist, attempt-kind + binding-contract enforcement, binding provenance on imported documents, declared-handoff recording. P1's `GATE_CONTRACT_OVERRIDES` is gone — contracts are declared; absent-contract refs still fall back to the stage-derived P1 default (compatibility, never invented) |
| `server/execution/state-service.mjs` | modified | `preparation.capabilities`/`preparation.adapters` service options surfaced as `ctx.preparationCapabilities()`/`ctx.preparationAdapters()` (command path AND the `/preparation` view path) |
| `scripts/preparation_binding_probe.mjs` | modified | probe argv/env now built by `planInvocation` (what was probed is what the adapter plans); new `preflight <id\|all> [--ws]` and `resources <id>` commands |
| `scripts/test_preparation_binding.mjs` | modified | `baseBinding` fixture declares the P2 contract (fixture-level, production validators unchanged) |
| `scripts/test_preparation_state.mjs` | modified | P1 fixture registry declares adapter/contract fields per stage (fixture-level; all 11 scenarios unchanged) |
| `scripts/test_preparation_skills.mjs` | **new** (1067 lines) | 23 node:test cases — see scenario map below |
| `docs/reports/agent-idea-preparation-p2.md` | **new** | this report |

Baseline dirt preserved: `git status --short` vs `/tmp/idea-p2-git-status-initial.txt`
— the **only** new entry is `?? scripts/test_preparation_skills.mjs`; every
other touched path lives inside the already-untracked `server/execution/preparation/`
tree or is itself an untracked baseline file (`state-service.mjs`, the two
existing test files, the probe). **Zero tracked files modified.**
No `src/`, compose, UI, pi-ext policy file, installed plugin, or
target-project write anywhere in the diff. `git diff --check`: clean.

## измерено

All runs on this checkout, this session. `node --test` bare runner; no
services started, no ports touched, no pi spawn, no network.

### P2 suite — `node --test scripts/test_preparation_skills.mjs`

```
ℹ tests 23   ℹ pass 23   ℹ fail 0   ℹ skipped 0   ℹ duration_ms 983.9
```

| Test | Covers |
|---|---|
| registry: production bindings carry the full declared contract | all 12 bindings: adapterId/version, requires, gateContract, result, manifest; handoff targets resolve |
| registry: an available binding without a declared contract is refused | `invalid_registry` on missing gateContract / missing result / non-array contract / unknown gate type / artifact gate on intent stage / docKind ≠ stage |
| registry: a handoff to an unregistered binding refuses at load | dangling handoff target → `invalid_registry` |
| config digest: canonical across key order, moves with any contract field | stable under key reorder; changes on adapterVersion/channel/requires/gateContract/tools/result edits; independent of resourceManifest |
| preflight: unsupported/candidate routes refuse before planning | production `ce-work` → `route_unsupported` (preflightContract AND planInvocation); `adapterFor` → `adapter_unavailable`; test candidate → `route_unproven` |
| preflight: missing capability / adapter failures carry structured details | `capability_missing` `{missing,required}`; `adapter_unavailable`; `adapter_version_unsupported`; `adapter_unsafe` `{unservable}`; `resources_unpinned`; reduced-host injection |
| preflight: drifted pinned resource refuses the full check | file tamper → `resource_mismatch` `{changed}`; file removal → `{missing}` |
| resources: loader serves the exact pinned bytes; drift refuses | per-file sha256 == manifest; loaded text === disk bytes verbatim; entry points = pinned SKILL.md; tamper → `resource_mismatch` |
| adapter plan: argv passes the pinned dirs via --skill; refuses bad inputs | `--skill <pinnedDir>` verbatim, `-e` bridge, `--no-skills/--no-context-files/--no-extensions`, `--tools`, cwd/env roots; `adapter_version_unsupported`/`resources_unpinned`/`invalid_argument` |
| result channels: command/api/tool/exec keys refuse outright | `commands`/`api`/`toolCalls`/`exec`/arbitrary + nested `document.exec`, `proposal.api`, `handoff.toolCalls` → `result_channel_unsupported` `{offending}`; whitelist passes |
| translateResult: contract enforcement + declared handoffs only | conversation binding + document → `result_off_contract`; wrong docKind → `{contractDocKind}`; undeclared handoff → refused; declared → `{mode:'host_choice'}` recorded |
| assignment: unsupported/capability/adapter/resource refusals are fail-closed | through `start_preparation` on the real service: `route_unsupported` `{reason}`, `capability_missing` `{missing,required}`, `adapter_unavailable`, `adapter_version_unsupported`, `adapter_unsafe`, `resources_unpinned` — **and no session minted** |
| assignment: a missing on-disk resource refuses at binding time | deleted pinned file → 422 `resource_mismatch` `{missing:[…]}`; no session minted |
| assignment: reduced host capabilities refuse through the ctx seam | injected descriptor without `tool.write` → `capability_missing` `{missing:['tool.write']}` |
| assignment: binding refs snapshot digest + configDigest + contracts | durable ref carries both digests, adapter id/version, declared gate/result contracts; minted gates carry the same snapshot |
| substitution: swap to another registered binding; phase machine unchanged | `unknown_binding`/`route_unproven`/`route_unsupported` refusals; real swap → old gates invalidated `binding_changed`, fresh gates under new ref, phase machine/approvals untouched; same-id no-op → `changed:false`; `gateContract:[]` binding mints zero gates, zero gate blockers |
| config drift: contract edit → binding_config_changed; explicit migration restores | requires/handoff edit → `binding_config_changed` blocker (not `binding_digest_changed`); same-id `change_skill_binding` migrates; **checkpoint questions/decisions retained**; `binding_migrated` logged; fresh gate confirms |
| config drift: stale gates cannot confirm under the moved contract | `confirm_gate` on a pre-edit gate → 409 `gate_digest_stale` |
| prep_result: injection channels refuse; the session state is untouched | 8 payload shapes (top-level + nested) → 422 `result_channel_unsupported` `{offending}`; aggregate byte-stable (no questions/decisions/documents minted); whitelisted result still applies |
| prep_result: document/handoff enforce the binding result contract | draft-attempt kind mismatch → `result_off_contract` `{expected,kind}`; undeclared handoff → refused, no assignment; declared handoff → `applied.handoff` + `handoff_recorded`, assignment unchanged; requirements import carries `meta.bindingId/bindingDigest/bindingConfigDigest` |
| prep_result: importAs=none contract refuses a document outright | `result_off_contract` `{bindingId}` for a non-importing contract route |
| provider digests: registry pins and on-disk bytes unchanged by the suite | before() snapshot vs post-suite: all 12 `resourceManifest.digest` + `bindingConfigDigest` identical; `verifyManifest` green on all 6 available bindings |
| bounded real-registry preflight: available bindings pass; unsupported refuse | `preflightBinding` over the production registry with `fsCheck`: 6 available pass with resolved `{digest,configDigest,capabilities,gateContract,result}`; 6 unsupported → `route_unsupported` |

### Regression — unchanged suites, same commands

```
node --test scripts/test_preparation_binding.mjs   → 18/18 pass  (  183ms)  P0
node --test scripts/test_preparation_state.mjs     → 11/11 pass  ( 1126ms)  P1
node --test scripts/test_preparation_skills.mjs    → 23/23 pass  (  984ms)  P2
node --test scripts/test_execution_ui.mjs          → 53/53 pass  ( 4917ms)
node --test scripts/test_fusion_controller.mjs     → 11/11 pass  ( 3746ms)
node --test scripts/test_fusion_handoff.mjs        →  8/8  pass  ( 9969ms)
node --test scripts/test_execution_environment.mjs →  1/1  pass  (  233ms)
node --test scripts/test_sfc_loader.mjs            →  1/1  pass  (  109ms)
node --test scripts/test_ui_store.mjs              →  3/3  pass  (  417ms)
node --test scripts/test_workflow_porch.mjs        → 51/51 pass  (  153ms)
node --test scripts/test_ws_transport.mjs          →  1/1  pass  ( 1105ms)
```
Total: **180/180 pass, 0 fail** (baseline was 102/102; +23 P2 tests, plus the
same deterministic suites all green). Baseline snapshot for this run:
`/tmp/idea-p2-git-status-initial.txt`; final: `/tmp/idea-p2-git-status-final.txt`
— single added entry `?? scripts/test_preparation_skills.mjs`.

### Bounded real-registry evidence (probe driver, no spawn)

- `node scripts/preparation_binding_probe.mjs preflight all` →
  `/tmp/idea-p2-evidence/preflight-all.jsonl` — 6 available bindings resolve
  `{adapterId, digest, configDigest, capabilities, gateContract, result}`;
  6 unsupported refuse `route_unsupported` with their named reasons
  (exit 1 as designed). Raw stderr: `/tmp/idea-p2-evidence/preflight-all.err`.
- `node scripts/preparation_binding_probe.mjs resources ce-brainstorm` →
  `/tmp/idea-p2-evidence/resources-ce-brainstorm.json` — 26 pinned files
  re-hashed on read; entry = the provider's original
  `…/ce-brainstorm/SKILL.md` path verbatim; digest `b6a7ba03…` ==
  manifest pin.
- `node scripts/preparation_binding_probe.mjs verify all` →
  `/tmp/idea-p2-evidence/verify-all.json` — all 12 manifests re-hash clean
  post-change (digests match the P0 pins; provider sources untouched).
- Plan shape evidence: `planInvocation` for `ce-brainstorm` →
  `/tmp/idea-p2-evidence/plan-ce-brainstorm.json` — identical argv/env shape
  to the P0 inline probe construction (`--mode rpc --provider… --session-dir
  --name --no-extensions -e preparation-bridge.ts --no-skills --skill
  <pinned> --no-context-files --no-prompt-templates --no-themes -na
  --tools …`), cwd=workspace, env carries scoped agent/session dirs +
  `ACP_PREP_*` containment roots.

## не измерено

- **No live pi spawn in P2.** The probe still launches real pi, but P2 only
  re-moved its argv construction into `planInvocation`; the deterministic
  plan shape is asserted above and the P0 real-probe evidence stands — the
  spawned command did not change. A fresh end-to-end pi run under the new
  planning path is a P3 (lead driver) exercise.
- **No production service / compose run.** The ctx seams were exercised
  through `createStateService`'s real request + internalCommand surfaces
  only; wiring behind `ACP_EXEC_PREPARATION=1` in a live stack is untested
  here by design (no services started).
- **Cross-skill result translation against real pi output.** `translateResult`
  is exercised with synthetic payloads; its consumer (the lead driver that
  turns a pi turn into a `prep_result`) is P3.
- **`grill-with-docs` stage semantics.** Its declared contract is
  `importAs:none` conversation-style with `docKind:null` — it produces
  context documents as workspace artifacts, not session documents; that is
  the honest declaration of what P0 probed.
- P3+ scopes (lead driver, handoff dispatch, Fusion/Orchestrator/Swarm, UI)
  are untouched and unmeasured.

## Известные разрывы / P3 dependency

- The **adapter invocation contract is planned, not driven**: `planInvocation`
  returns argv/env/roots; the lead driver (P3) must own the spawn, the RPC
  turn protocol, and feeding `prep_result`. The channel whitelist +
  contract enforcement it must satisfy is already enforced server-side.
- **Declared-handoff dispatch is intentionally absent**: `host_choice`
  handoffs are recorded evidence for a user decision; wiring the user's
  selection into an actual route transition is P3+ (and only through
  `change_skill_binding`/registered routes).
- `assertResultChannels` runs on the raw `payload.result`; adapters translate
  upstream. A driver bypassing `translateResult` is still bounded by the
  session-side whitelist — fail-closed either way.
- `preflightBinding` with `fsCheck` verifies declared roots exist; it does
  not (and should not) verify provider CLI availability — `runtime.pi` is a
  declared capability exercised by the probe, consistent with P0.
