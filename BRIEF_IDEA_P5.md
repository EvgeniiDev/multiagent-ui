# P5 — Idea Preparation UI, browser E2E, and release acceptance

## Location and verified context

- Host: Linux, repo `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`.
- Runtime is Docker Compose only (`compose.yaml`); frontend builds on host with `npm run build:web`.
- This checkout is intentionally dirty: a pre-run snapshot is `/tmp/idea-prep-p5-baseline.status` (118 status entries; SHA-256 `aa1005d53a1184ce4cb17815193ddfce4f8794ba065e998cb98fcf67c9ba0e77`) and HEAD snapshot `/tmp/idea-prep-p5-baseline.head`. Preserve all existing work/artifacts; do not reset, clean, stash, revert, commit, push, publish, or delete anything except a temporary artifact you personally created and can prove you own.
- Porch confirmed no active run before this dispatch. You are the sole product writer. Do not launch subagents or other writers.
- Plan of record: `docs/plans/agent-idea-preparation-plan.md`, especially P5 lines 131–145 and the Verification Contract. Read it and all P0–P4 reports before editing. Current implementation/test files are in `server/execution/preparation/`, `scripts/test_preparation_*.mjs`; P5 surface includes `src/components/BoardView.vue`, `src/features/board/CardDrawer.vue`, `src/components/WorkflowPanel.vue`, stores, and settings. P3 report explicitly leaves the real lead-driver Pi turn and runner-side lead supervisor unverified/unwired; P5's required real selected-profile/binding behavior must close this gap with the narrowest P5-scoped integration. Do not infer runtime integration from fake Pi transport tests.
- Independently measured immediately before dispatch: combined P0–P4 + regression command (listed below) **213/213 pass, 0 failed, 0 skipped**, exit 0, duration 11.94 s; host `npm run build:web` exit 0, Vite 6.4.1, 3.59 s. Existing >500 kB bundle warning remains. These are baseline evidence, not P5 acceptance.

## Objective

Complete ONLY Idea Preparation P5 from the plan and carry forward its explicitly required real-runtime gates: one durable user conversation in the card/chat, bindings and compatibility, explicit approvals and handoff, persistence across browser reload/session restart, and honest fail-closed controls. Keep the stage order P0→P5 and do not expand into Fusion implementation, Orchestrator, Swarm, unrelated backlog, Tauri changes, or provider/plugin source changes.

## Scope and ownership

Allowed product files: the plan's P5 UI/chat/store/settings files and the minimum `server/acp-runner.mjs` / `server/execution/preparation/**` / API integration strictly necessary to host and exercise the P3 lead runtime in the actual application. Add acceptance scripts/tests for P5 and any required regression test. Do not edit third-party installed skill/plugin sources, unrelated server/runtime paths, `compose.yaml` except a proven project-scoped test-only adjustment strictly required by the plan (report first), or unrelated features. If a forbidden seam is needed, document it in the report before touching it and make the smallest justified change.

## Required behavior (plan P5)

1. Card UI shows preparation phase, one durable discussion, current document versions and completeness, assumptions/open questions, skill bindings/compatibility and explicit approvals/gates; handoff to downstream is a distinct action and never auto-starts implementation.
2. Small and complex tasks complete end-to-end using the actual selected Pi profile and each advertised initial binding, including real question/answer/dialog, document import, stop/resume/reload behavior. Unsupported bindings show a specific reason and fail closed. Ensure target project/plugin sources are unchanged.
3. Two browser tabs/racing command produce one session; stale command/revision returns conflict without overwriting; offline controls are disabled; no optimistic success; closing/reopening/reloading restores the discussion from durable state.
4. A changed skill binding is explicit, retains the discussion/checkpoint, invalidates dependent gates, and never silently changes pinned skill resources. AE4: source digest drift is surfaced and the pinned/current choice is explicit.
5. Actual document requirements and plan are separately approved by exact version/hash; stale/draft docs and unresolved required gates cannot expose ready/start; intent changes invalidate dependent approvals/gates; implementation begins only after separate explicit user action.
6. Legacy cards with already accepted documents continue to the core path without forced interview. Handoff packages carry current accepted inputs and context; do not claim consumers exist for modes marked `implemented:false`.
7. Provide a genuine browser E2E (not SSR-only) for one small and one complex flow, reload/continuation, binding replacement/incompatibility, approval and handoff gating, concurrent/stale revision, offline controls, and legacy card. Show actual UI evidence and errors.
8. Preserve existing Compose services/ports and Tauri boundary. Run the host frontend build and the exact deterministic P0–P4 plus board/execution/workflow/ACP regression suites. Run real Pi/profile/binding smoke(s) and Browser P5 E2E. Do not claim P5/full feature accepted until every required gate has evidence.

## Operational constraints

- Before any service start/recreate/redeploy: run `docker compose ps` and `ss -tlnp`; identify exact target containers and active consumers, capture user-impact observations and current config/image/container identities. Never start an ad-hoc server or use a second port.
- Production redeploy of this ACP UI Compose project is authorized during development, but is optional; use the narrowest reversible action and report measured user impact (or say not measured). Restore/health/read-back must be explicit. Do not touch unrelated services.
- Do not modify Tauri branches or installed plugin/skill source. Keep project changes reversible and preserve the dirty baseline; no commit/push/publication.
- If any required criterion cannot be completed, state exactly which gate is blocked and why. Do not skip an E2E criterion and call the phase green.

## Acceptance commands and evidence

Run at minimum:

```sh
node --test scripts/test_preparation_binding.mjs scripts/test_preparation_state.mjs scripts/test_preparation_skills.mjs scripts/test_preparation_lead.mjs scripts/test_preparation_handoff.mjs scripts/test_execution_ui.mjs scripts/test_fusion_controller.mjs scripts/test_fusion_handoff.mjs scripts/test_execution_environment.mjs scripts/test_sfc_loader.mjs scripts/test_ui_store.mjs scripts/test_workflow_porch.mjs scripts/test_ws_transport.mjs
npm run build:web
node scripts/preparation_binding_probe.mjs verify all
node scripts/preparation_binding_probe.mjs audit all
```

Use/extend a real browser E2E and real Pi/profile lead probe; record exact command, exit, test count, timings, run IDs, evidence paths, and restore/read-back checks. Re-run all acceptance criteria independently on the final dirty tree after your changes; the manager will independently repeat them.

## Report format

Write `docs/reports/agent-idea-preparation-p5.md` and append a factual checkpoint to `docs/reports/agent-idea-preparation-manager-acceptance.md` using:

- `STATUS: DONE | PARTIAL | BLOCKED`
- for each P0–P5: module status vs runtime/integration status (never conflate them)
- **измерено / вывод / не измерено**
- exact commands, counts, durations, run IDs, browser/E2E evidence paths, build output, Pi/profile probes, Compose state before/after
- dirty-tree delta vs the supplied baseline; enumerate changes without deleting baseline entries
- remaining risks and the exact next gate

Do not write a completion claim until the independent acceptance artifacts exist and pass. End your executor response with `P5 ГОТОВ` only if all P5 acceptance criteria have actually passed; otherwise state `P5 PARTIAL` or `P5 BLOCKED` with the failed gate.