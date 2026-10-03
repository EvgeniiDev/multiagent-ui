# Idea Preparation P2 — SkillBinding and compatibility

Repo: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. You are the sole product writer; one active run only. Work strictly on P2 from `docs/plans/agent-idea-preparation-plan.md`; do not expand into P3–P5, Fusion, Orchestrator, Swarm, unrelated backlog, UI, production rollout, or live user services.

## Accepted dependencies / inspect first

P0 acceptance evidence: `docs/reports/agent-idea-preparation-p0.md` (including the later real-Pi symlink-containment hardening) and P1 report: `docs/reports/agent-idea-preparation-p1.md`. The parent independently reran the combined deterministic Node regression suite: 102 tests, 102 pass, 0 fail, 0 skipped (includes P0 binding, P1 state, execution UI, Fusion controller/handoff and environment suites). Preserve all pre-existing dirty/untracked work; the checkout is intentionally very dirty. A baseline snapshot for this run is `/tmp/idea-p2-git-status-initial.txt`.

Read the plan P2 section and P0/P1 reports plus the relevant current implementation before editing. Reuse P0 `bindings.json`, pinned original-resource manifests and fail-closed registry; P1 `session.mjs` binding references/change command, `ctx.preparationRegistry()` / `ctx.preparationVerify()`, and its gates. Do not mutate installed/upstream skill sources or the target project. Existing behavior stays fail-closed.

## Implement exactly P2

Implement configurable SkillBindings, original-resource loading, capability preflight, pinned resource hashing/version snapshots, and adapters for the initial supported bindings as specified by the plan's KTD3–KTD7 and P2 acceptance scenarios. Declare gate contracts on bindings rather than relying on P1's stage-derived `GATE_CONTRACT_OVERRIDES` seam, preserving P1 semantics and compatibility. Ensure binding substitution uses registered/probed routes only; missing capabilities/resources, unsupported route, resource digest drift, stale version, and unsafe/unavailable adapter produce structured actionable refusals with no silent fallback. Runtime resources loaded must be the original pinned resources, not rewritten prompts or a textual imitation. Do not claim a source skill's mandatory handoff/tool behavior is supported unless verified.

Required runtime tests in new `scripts/test_preparation_skills.mjs` (or the plan-named location) using production registry/state factories and fake skill/runtime adapters where appropriate:
- substitute a test binding without changing the phase machine;
- missing resource/native capability and declared approval/gate contract;
- digest drift/change during a session, explicit migration retaining checkpoint while invalidating dependent gates/approvals as required;
- resource/prompt injection cannot invoke API/admin commands;
- provider/upstream source digests before/after unchanged;
- unsupported binding refused before spawning/writing; exact structured errors;
- existing P1 scenarios and supported P0 path remain green.
No source-grep tests, tautological assertions, weakened containment, or tests that bypass production factories. For external skill behavior, run only bounded probes explicitly needed by P2; retain raw evidence and do not touch target project writable.

## Boundaries and constraints

Expected ownership: `server/execution/preparation/skills/`, minimal necessary `server/execution/preparation/` integration and a narrowly justified P1 seam, `scripts/test_preparation_skills.mjs`, P2 report and bounded evidence artifacts. Avoid `src/`, Compose, UI, unrelated execution core, P0 extension security policy, installed plugins/skills, target-project writes, production services, commits/pushes/publication, and cleanup/deletion of baseline artifacts. No reset/clean/stash. If touching forbidden/shared files seems necessary, record the exact integration request and stop before widening scope.

## Report / handoff

Write `docs/reports/agent-idea-preparation-p2.md` with `STATUS: DONE|PARTIAL|BLOCKED`, sections `измерено / вывод / не измерено`, exact commands/counts/durations and unedited significant output, raw artifact paths, files changed, scenario→test evidence, known gaps and P3 dependency. Compare `git status --short` with `/tmp/idea-p2-git-status-initial.txt`; enumerate only your changes and confirm baseline preserved. Do not claim P2 accepted; parent independently reviews integration and reruns. End `P2 ГОТОВ` only if your implementation and tests/report are complete, otherwise `P2 ЧАСТИЧНО`/`P2 BLOCKED` with evidence. Keep changes focused and build/tests green.