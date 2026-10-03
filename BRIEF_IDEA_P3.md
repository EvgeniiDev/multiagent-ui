# Idea Preparation P3 — one lead and adaptive discussion

Repo: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. You are the sole product writer; at most one active Porch run for this project. Implement only P3 from `docs/plans/agent-idea-preparation-plan.md` (lines 115–121; R2–R4, R6, R9–R10, KTD2/KTD5–KTD7). P0/P1/P2 dependencies have independent acceptance evidence in the reports; P2 was just independently rerun by the parent: P0/P1/P2 suites 52/52 pass, regression batch 73/73 pass, manifests verify/audit 12/12 each. Parent captured a fresh baseline at `/tmp/idea-p3-accepted-baseline.txt` before dispatch. Preserve all existing dirty/untracked work.

## Read first
Read the P3 plan section, accepted P0/P1/P2 reports, and the relevant current sources/tests. P0/P1/P2 artifacts include `server/execution/preparation/{skills,session.mjs}`, `server/execution/state-service.mjs`, `server/execution/execution-domain.mjs`, `scripts/preparation_binding_probe.mjs`, `deploy/pi-rpc-boundary.mjs`, and `scripts/test_preparation_state.mjs` / `scripts/test_preparation_skills.mjs`. Reuse the durable `prep_result` internal command, `PREP_DEPS`, P2 `planInvocation`, and P0's contained RPC extension. Do not assume prior P3 investigations were implementation; inspect actual files and git baseline.

## Implement exactly P3
Build the single lead driver and durable interactive discussion transport in `server/execution/preparation/` and the narrowly needed CLI/ACP connection. The lead receives the goal/stage/current documents/decisions/checkpoint and new answers; it returns only a supported question, document, proposal, or structured blocker. Save checkpoint/artifact before the next turn. Use one preparation discussion identity across CLI session changes; do not start a second interview when a skill is added or the CLI session changes.

Implement and test the actual Pi RPC question protocol: an in-turn native UI question is routed via `extension_ui_request` and matching `extension_ui_response` for the same request/attempt; a question returned after the turn ended is answered through the next prompt. Persist durable questionId/attemptId/type; answer retries are idempotent; no stale/duplicate answer may mutate a stopped/superseded attempt; lost process/open dialog recovers the question from checkpoint with a fresh RPC request ID. Preserve P0 containment and P2 result-channel whitelist; do not fabricate answers or execute text as ACP commands. Unsupported native skill tools/workflows must be shown as unsupported, not silently imitated.

Use bounded outcomes and limits for loops, frames, timeouts, and repeated no-progress; human waiting is not an agent timeout. Stop cancels only the active preparation attempt. CLI loss/restart resumes from durable checkpoint. Changing binding preserves intent and prior user responses. Never start implementation, invoke Fusion, or alter lifecycle/approval authority.

## Required scenarios / acceptance tests
Add `scripts/test_preparation_lead.mjs` using production factories and deterministic fake runtime/transport where appropriate. Cover all P3 scenarios from the plan:
- small/simple task takes the short route; complex task requests additional distinctions;
- accepted answers are not repeated; no-progress loop ends with explicit limit/blocker;
- human wait is not treated as a runtime timeout;
- native dialog gets matching extension_ui_response without an extra prompt, while an already-ended question is answered in the next prompt;
- duplicate answer, stop, and restart with an open dialog cannot hang, cross attempts, or confirm an unrelated attempt;
- stop cancels active attempt; restart/CLI loss restores from checkpoint; binding change preserves intent.

Tests must assert runtime behavior (no source-text grep, no tautologies), exercise real state service/domain production seams, and prove fail-closed behavior. Run P0/P1/P2 suites and relevant execution/UI/Fusion regressions after changes. No long/broad live test; for any real Pi probe, keep it bounded, private-workspace-only, preserve raw evidence, and do not modify installed/upstream skills or the target project. No production service/Compose/UI work in P3.

## Hard boundaries
Own only `server/execution/preparation/` P3 files, the minimal justified CLI transport integration file(s), `scripts/test_preparation_lead.mjs`, raw bounded evidence under `/tmp`, and this P3 report. No P4/P5, no `src/`, Compose, unrelated execution/Fusion/Orchestrator/Swarm code, installed plugins/skills, target-project writes, live services, commit/push/publication, reset/clean/stash, or deletion/cleanup of baseline files. If P3 needs a forbidden/shared file, stop and report the exact integration request instead of widening scope. One writer only.

## Report and completion
Write `docs/reports/agent-idea-preparation-p3.md`, shape: `STATUS: DONE|PARTIAL|BLOCKED`; `измерено / вывод / не измерено`; exact commands/counts/durations and significant raw output; test-to-scenario map; files changed; known gaps and P4 dependency. Compare final `git status --short` to `/tmp/idea-p3-accepted-baseline.txt`, enumerate only your delta and confirm baseline untouched. Do not claim P3 accepted; parent independently reviews source and reruns the tests. End with `P3 ГОТОВ` only when your implementation and checks/report are complete; otherwise `P3 ЧАСТИЧНО` or `P3 BLOCKED` with evidence. Keep one-step implementation commits unnecessary: do not commit.
