# Idea Preparation P4 — requirements, design, plan, and handoff

Repo: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. You are the sole product writer; at most one active Porch run for this project. Implement only P4 from `docs/plans/agent-idea-preparation-plan.md` (lines 123–129; R1, R4–R7, R11, KTD6–KTD8). Do not expand into Fusion, Orchestrator, Swarm, P5 UI/browser work, or unrelated backlog.

## Independently accepted dependencies

P0 containment hardening, P1 state/session, P2 binding compatibility, and P3 lead module have passed manager-run checks on the current worktree:
- `node --test scripts/test_preparation_binding.mjs scripts/test_preparation_state.mjs scripts/test_preparation_skills.mjs scripts/test_preparation_lead.mjs` → 75/75 pass.
- P0 live containment smoke `node scripts/preparation_symlink_smoke.mjs --run watchdog-accept-20261002-213236` → status pass; 4/4 live Pi tool escape attempts blocked before execution; outside filesystem intact. Run evidence: `/home/hermes/.cache/acp-p0/watchdog-accept-20261002-213236-symlink-escape-smoke` (smoke's printed name may include `-symlink-escape-smoke`).
- `node scripts/preparation_binding_probe.mjs verify all` and `audit all` → 12/12 each.
- Regression batch `node --test scripts/test_execution_ui.mjs scripts/test_fusion_controller.mjs scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs scripts/test_sfc_loader.mjs scripts/test_ui_store.mjs scripts/test_workflow_porch.mjs scripts/test_ws_transport.mjs` → 129/129 pass.
- `npm run build:web` → exit 0; Vite 6.4.1 built successfully (existing >500 kB chunk warning).

P3 module is accepted, but its report explicitly says it did not run the lead driver over a real Pi process and runner hosting is not yet wired. Do not claim those runtime gates are already proven; close or explicitly preserve them as P4 integration requirements where this scope enables them. P0 has real Pi skill probes, but those are not evidence for the P3 lead driver transport.

Baseline `git status --short` was captured before this run at `/tmp/idea-p4-baseline-20261002.txt` (114 entries, SHA-256 `1d9e2df726d30d4f1fb68b196548bc186e8a0285d957b2f7d834cb170796d40a`). Preserve all baseline dirty/untracked files. No reset, clean, stash, commit, push, publication, deletion of baseline files, or plugin/upstream edits.

## Implement P4 only

Work in the plan's P4 surface: `server/execution/preparation/`, document/approval modules in `server/execution/`, and `scripts/test_preparation_handoff.mjs`. Provide the minimum justified server/runtime wiring needed for a preparation result to become immutable `DocumentVersion` records and for valid handoff/readiness to use existing core approvals. Reuse P1/P2/P3 state, binding contracts, checkpoints, gates, `prep_result`, and the existing approval lifecycle; do not create a second approval authority or invent UI status fields. Do not edit `src/`, Compose files, installed skills/plugins, or external project files. If a necessary integration seam lies outside scope, record it precisely under Integration requests rather than silently broadening ownership.

Requirements:
- Import generated requirements/design/plan as immutable, versioned documents with provenance and current-intent/binding links; expose completeness, assumptions, and open questions.
- Never produce/accept an implementation plan without an accepted current requirements version. Any plan must reference that exact requirements version/hash.
- Design remains optional unless material alternatives/risks require it; when present, preserve its own version and any actual binding SkillGate. Never treat approval of another document as a skill-gate confirmation.
- Readiness requires current core approvals, current intent/artifact versions, required gates for bindings used, and no blocking open questions. Recheck in the implementation start seam; stale/new versions or binding changes must not inherit approvals/gates.
- Handoff to solo/Fusion/orchestrator/Swarm is data/availability only; do not auto-start implementation or invoke another mode. Fusion-returned documents become a new unapproved version.

## Required scenarios / tests

Implement `scripts/test_preparation_handoff.mjs` against production state/domain factories and internal seams, using deterministic fake runtime/adapters as needed. Cover the P4 plan scenarios exactly:
1. AE1 small task: concise requirements then short plan; no mandatory separate design.
2. AE2 complex task: requirements/design as needed then plan, with prior answers preserved.
3. Plan references the exact current requirements version/hash; no plan without accepted requirements.
4. Draft/unaccepted documents and approvals for prior versions do not permit start; approval of v1 cannot approve v2.
5. Requirements/plan approvals alone do not bypass open intent/design SkillGates; start remains blocked until the exact presented subject is confirmed.
6. Changed restatement/spec/digest invalidates only dependent gates and requires explicit reconfirmation (AE3).
7. Accepted package can be handed to each named downstream mode without a new interview; this does not start implementation.
8. A Fusion-returned document creates a new version and is not auto-approved.

Tests must assert runtime behavior, not source-text patterns; no tautologies. Include crash/restart/idempotency boundaries where P4 document import/handoff touches durable writes. Preserve P0 resource/source integrity. Run P0–P4 suites and the relevant execution/approval/board/Workflow/ACP regression batch after changes. Do not run browser P5 or deploy production as a substitute for missing P4 unit evidence.

## Report / done criteria

Update `docs/reports/agent-idea-preparation-p4.md` with `STATUS: DONE|PARTIAL|BLOCKED` and distinct `измерено / вывод / не измерено` sections. Include exact commands, exit codes, counts/durations, scenario-to-test map, changed files, raw evidence paths, integration requests, and remaining runtime gaps. Compare final `git status --short` with `/tmp/idea-p4-baseline-20261002.txt`; enumerate only this run's delta, do not claim byte identity from a path-list comparison. No commit/push. End with `P4 ГОТОВ` only if implementation and your own checks/report are complete; parent will independently inspect source/diff and re-run acceptance before deciding whether P4 is accepted. Do not start P5.