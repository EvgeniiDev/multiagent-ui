# ACP UI — release verification, 2026-10-03

Integration branch: `ship/agent-modes-20261003`. Runner source revision: `25f2f75`; controller archive repair `e57fda3`, UI verifier grant repair `99970ff` and state projection repair `e3d2f13` are deployed separately without interrupting model roles. Workspace: `/home/hermes/projects/acp-ui-lead-integration`.

Status: the requested production panel flows are accepted: preparation plus all three native development modes. Plan-specific live limitations are stated below.

## Production and user-facing acceptance

The production state service, runner and web server use the integration checkout. Runtime flags enable Core execution, validation, Fusion, Preparation, Orchestrator and Swarm. The host-built web bundle is served through the existing TLS front. The original 43 board cards are preserved; four explicitly named acceptance cards were added in the dedicated project `acc-b20261003214157-modes`.

Acceptance uses the real production panel, real Porch/Pi providers and a separate Git source `/home/hermes/projects/acp-acceptance-20261003`. The generated requirements and plan were approved as exact versions/hashes. The harness checks the selected native mode and completed provider roles, actual commands/exit codes, immutable result hash, and independently runs three clamp assertions and nonempty Node tests in the bound result workspace. Development documents, provider outputs and success states were not injected.

| Panel flow | Current evidence | Result |
| --- | --- | --- |
| Brainstorm / grill preparation | `browser-production/receipt-preparation.json` | Passed: three real questions, generated requirements and plan, exact approvals, card ready; no implicit development run |
| Fusion | `run_34644f5e-ad1d-420d-a645-7551f36c0e49`; `browser-production/fusion-provenance-final.json` | Passed: six actual provider attempts, two panelists plus judge/integrator/reviewer/checker, three actual tests, UI result acceptance |
| Orchestrator | `run_e7f850fd-caab-40c2-8881-6c735f165131`; `browser-production/receipt-orchestrator.json` | Passed: real approved graph, dependent workers/verifiers, assembler, three tests, reviewer/checker and UI acceptance |
| Swarm | `run_cb7cd877-171a-4a5e-a580-e8c1b1e10bdd`; `browser-production/receipt-swarm.json` | Passed: two completed participants, preserved real broker result, three tests, reviewer/checker and UI acceptance |

Orchestrator accepted result SHA-256: `cfcfa31d3e4e6f4f767b0fcb938bceef13b35d70fb8dbbc14ca102b2310e4fbe` (13 actual provider attempts, including two honestly failed parser attempts before the repair).

Swarm accepted result SHA-256: `24d6538e1e7927f38b80dcb0e037e03db463b395805b60d7141773c6529b6219` (five actual provider attempts, including one honestly rejected mode-mismatch turn before the archive repair). Swarm continued the original broker-authored canonical result at epoch 2; two real journaled edits created `clamp.js` and `clamp.test.js`. The accepted run used both real participants and fresh reviewer/checker; it did not invoke solo execution.

Fusion accepted result SHA-256: `e023c183af68831748b0e5dee0b53570e1c986301b49c87376857bf2b53fa5f1`.

Preparation requirements: `v_8817b6a7-d251-4865-92d4-8ce0b25cb506`, SHA-256 `d6803a229424ebeb942103d8cfd4930ad3d3c9dd0b38e6b81338061d46ad469a`. Plan: `v_43592363-3e3a-4474-aa48-920226e459b0`, SHA-256 `47ced6a13dc44b421a8b2165368af678bfb04488ff35f16b30db4eb16e823cd4`. A separate real preparation run answered four questions and preserved nested `acp-checks` text: `preparation-final-assertions/receipt.json`.

Final combined recheck: `browser-production/all-modes-final-proof.json` and `.log` record all three accepted runs, native completed provider roles, exact input/result hashes, actual nonempty tests and workspace probes, preparation ready and zero page errors. Fresh production screenshots: `browser-production/{preparation,fusion,orchestrator,swarm}-final-production.png`.

All private evidence paths in this report are relative to `.agent-tmp/autonomous/`; credentials and raw private transcripts are excluded from Git.

## Plan and criteria coverage

“Regression” below means an actual executed deterministic suite; it does not claim that every fault scenario was independently repeated against production. Live proof is identified separately. Plan scenario text remains authoritative in `docs/plans/agent-*-plan.md`.

| Unit | Criteria verified and evidence | Live coverage / remaining limitation |
| --- | --- | --- |
| U1 | Runtime launcher/status/events/wait/cancel, profile errors and process contract: `core-final-matrix.json`, runtime suites | Actual production Pi 0.85.1 via Porch, zen-relay Muse Spark 1.3 and 1.2. Full fresh production runs for every other CLI are not established by this report |
| U2 | CAS, command deduplication, approval version/hash, protected managed state and immutable documents: U2 34 regressions | Actual browser document approval and continued runs; stale internal revisions additionally reproduced with a real state service and competing validation heartbeat |
| U3 | Exact workspace/base, launch reservation and duplicate prevention, registry reconciliation: U3 43 regressions | Actual isolated workspaces; dependent Orchestrator inputs and canonical Swarm repository |
| U4 | Stop/drain, cursor reconciliation, process/environment identity, API outages and adoption: U4 61 regressions | Actual runner replacement, completed-response recovery, terminal worker cleanup; host ops retirement preserves the cross-namespace proof boundary |
| U5 | Snapshot/checks, reviewer/checker, findings, bounded repairs, exact-hash acceptance: U5 Core 31, domain 37, wiring 17 regressions | Fusion and Orchestrator checks/review/checker/acceptance passed; Swarm final gates passed |
| U6 | Profile editors, nested state shapes, documents/approvals, run details and continuation: execution UI/store regressions | Preparation and Fusion full panel paths; Orchestrator graph/spec/grants and Swarm decisions/continuation exercised |
| U7 | Integrated regression matrices, deployment flags, legacy preservation and rollback | Production deployed; selected primary flows exercised. Full all-CLI and all multi-tab/replay combinations are not claimed as live-tested |
| F1 | Controller identities, credentials, profile capability gates, safe import, network separation and released resources: controller 25 and environment 210 assertions; safe Git/import regressions | `controller-live-canonical-modes/receipt.json`: nine actual Docker proofs including readonly source, isolation, terminal network removal and retained evidence. Optional public search remains disabled and unproven |
| F2 | Panel launch/partial failure/cancellation/recovery: Fusion controller/lifecycle/reaper suites | Two real panelists and shared Core tail completed |
| F3 | Judge, result selection, handoff and immutable result: Fusion handoff/core suites | Actual judge→integrator result→checks→reviewer→checker→UI accept |
| F4 | Card/profile settings, Workflow and mode gate: UI/domain suites | Fusion production panel accepted; existing bridge and desktop entrypoint retained |
| P0 | Installed skill routes, document projection and provider compatibility: binding/skills suites and real skill probes | Actual `grill-me-intent` and `ce-plan` workflow; bounded task produced documents without implementation |
| P1 | Preparation idempotency/checkpoint, exact approvals and readiness gates: preparation state/handoff regressions | Card contains exact generated versions; requirements approved before plan |
| P2 | Binding resources/digests/capability preflight and structured incompatibility: skills/binding regressions | Real installed bindings used; upstream plugin sources preserved |
| P3 | One lead, question/answer continuation, checkpoint, timeout and cancellation: lead/runner regressions | Three questions through panel, four in separate real run; final model report alone does not imply readiness |
| P4 | Immutable import, requirements-bound plan, SkillGate and handoff: handoff/result-fence regressions | Actual nested checks imported; both documents and intent gate approved, ready true |
| P5 | Conversation, phases/approvals and controls: preparation UI 20 regressions and production browser | Full preparation panel path, zero browser JS errors |
| O1 | Graph validation, native mode start and preserved composition: graph/domain suites | Real decomposer produced approved three-task graph; spec rejection feedback and continuation preserve approved input versions |
| O2 | Private repositories, canonical dependency proof, exact bytes, overlap handling, safe publication: workspace/repair/resolution/safe-Git suites | Two actual task candidates accepted; dependent third worker received both parent results |
| O3 | Worker/verifier acceptance, explicit separate retry budgets, assembly and Core tail: driver/continuation/grant/parser/shared-validation suites | All three tasks accepted, actual assembler and shared checks/reviewer/checker passed; native Orchestrator UI acceptance succeeded, no solo fallback |
| O4 | Graph/tasks/attempts and budget controls: UI/domain suites | Real panel spec approval, explicit verifier grant, continuation and final exact-result acceptance |
| S1 | Durable messages, ownership, decisions, acknowledgments and revision conflicts: protocol/domain suites | Real panel resolved ownership decisions; user resolution is not described as independent peer consensus |
| S2 | Broker journal/replay, exact path/ancestor identity, mode restoration and no late writes: edits/safety/anchor-identity suites | Two actual broker transactions wrote clamp.js and clamp.test.js, replayed once after recovery; late/expired attempts cancelled |
| S3 | Turn budget, reconciliation, cursors, readonly workers, snapshot invalidation and verify-phase exclusion: driver/domain/runtime suites | Both real participants converged; continuation traversed shared validation, actual reviewer/checker and UI acceptance without CAS faults |
| S4 | Panel ownership/decisions and continued native mode: UI/protocol suites | Actual user decision and continued native Swarm run; final shared tail and UI result acceptance succeeded |

## Repairs discovered through actual execution and review

- Fixed preparation and Orchestrator result fences so quoted nested Markdown does not truncate JSON. Malformed and multiple result blocks still fail closed.
- Aligned full profile editors and nested task state with actual API records; continuation retains Orchestrator/Swarm mode and approved inputs.
- Repaired Orchestrator dependency assembly, provenance, overlap resolution and canonical publication. Safe Git operations avoid inherited hooks/filters and bound output; private publication validates paths and exact worker tree before import.
- Repaired Swarm crash recovery, journal delivery, snapshot gates, readonly-worker barriers and expired-attempt cancellation. Ownership and journal history remain durable.
- Supervised the reviewer/checker tail for both shared modes; completed responses from a physically dead environment are recovered rather than discarded.
- Fixed validation command CAS contention against its own heartbeat with a per-card serialized sender and monotonically observed revision. Unresolved conflicts retain the original journaled duty for reconciliation. A real state-service reproduction failed before the fix and passed afterward.
- Exposed existing durable workspace environment bindings in the card API. Previously the projection removed the exact fields the scheduler needed to consume an OPS retirement; no weaker owner proof or legacy inference was introduced.
- Separate explicit verifier retry grants preserve imported candidates and cumulative attempt numbering; late live-verifier grants are rejected. Captured worker responses are stored as attributed artifacts and presented as claims alongside actual freeze/test evidence.
- Terminal F1 resources are released durably through exact owned container/network IDs, preserving workspace evidence. This resolved actual Docker address-pool exhaustion without global pruning.

Earlier failed attempts, rejected reviews and timeout logs remain in the private evidence directory. They are not counted as passing acceptance.

## Fresh verification

- Sealed integration matrix: 23 suites, all exit 0 (`tests/sealed-matrix.json`).
- Core/runtime matrix: 12 suites, all exit 0 (`tests/core-final-matrix.json`); UI/preparation matrix: 10 suites, all exit 0 (`tests/ui-preparation-matrix.json`). These matrices overlap and are not summed as distinct tests.
- Latest affected full Core rerun: U4 61/61, U5 domain 37/37 and runner wiring 17/17 (`tests/*-release-affected.log`).
- Latest Orchestrator six-suite rerun: 55/55, including real-state verifier grants, nested result fences and captured worker reports.
- Latest Swarm six-suite rerun: 79/79. Shared validation contention/outage/cancellation/adoption checks: 16/16. Final state-projection/shared-mode suite: 8/8, including refusal without retirement and successful adoption through the actual projected owner after exact OPS retirement.
- Latest controller suite: 25/25; environment script: 210 assertions. Snapshot archive regression: three actual Git mode tests plus related suites, 14/14. Actual Docker controller acceptance after the Git archive repair: 9/9, including exact regular 0644 and executable 0755 modes.
- Final web build after verifier grant UI repair passed (`tests/web-release-verifier-grant.log`); execution UI suite 71/71, including a real SSR regression that failed before the button repair. Strengthened browser provenance self-check and Python compilation passed.

## Deployment, recovery and rollback

Compose project `acp-ui` retains its existing ports (web 25808, TLS 25809, state 25900 and existing bridges). Deployment uses the integration `compose.yaml` plus `compose.prod-env.yaml`; only named services are recreated. F1 controller/egress uses project `acp-ui-agent-modes`. No global cleanup, prune or compose down was used. `deploy/acp-ws-bridge.mjs` and Tauri entrypoints remain unchanged.

Before replacing a runner, capture its exact current environment with `scripts/retire-environment.mjs --record`, including slot, generation, container hostname and init starttime. After confirmed destruction, use the recorded receipt to retire the exact old generation through the host-only ops route. A new registration, lease expiry or hostname absence alone is insufficient. Generation 14 was retired using a same-boot exhaustive host /proc scan (no unreadable processes), exact current-runner visibility proof and captured Docker die/destroy evidence; the real Orchestrator then adopted generation 15. Evidence: `runner-generation14-host-retirement-proof.json`. The strict helper and domain proof contracts were unchanged. The subsequent API repair exposes the already persisted workspace environment bindings so the scheduler can consume the same exact retirement proof. Current generation 15 has a live-verified preflight receipt in `/home/hermes/.acp-ops/env-receipts/host-runner--g15.json`.

Original production container inspect specifications and generated restore override are in `.agent-tmp/autonomous/rollback/` with private permissions. Restore only the affected named services from that captured override; preserve the production state directory. The original dirty source workspace and consolidation checkpoint `854397d` remain available. Avoid restarting a live checker/reviewer simply to refresh source; Node imports require a restart, so finish or safely stop owned attempts first.

## External limitation

The registered Pi public-search extension encountered a real upstream HTTP 202 challenge. Egress connectivity alone was not accepted as model search capability; the stale positive capability receipt was revoked. Tested mode profiles explicitly have search disabled. Search-enabled use must obtain a successful real provider probe for the exact effective profile digest before launch. No search response or CAPTCHA completion was simulated.
