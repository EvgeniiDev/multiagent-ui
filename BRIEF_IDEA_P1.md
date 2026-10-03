# Idea Preparation P1 — preparation session/state and phase transitions

You are the sole product writer for this stage. Work in `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. The owner-authorized scope is strictly P1 of `docs/plans/agent-idea-preparation-plan.md`, from P0→P5; do not start P2 or touch Fusion, Orchestrator, Swarm, other backlog, release/production services, or unrelated project files.

## State and dependencies

- P0 has an acceptance report at `docs/reports/agent-idea-preparation-p0.md`; parent independently reran `node --test scripts/test_preparation_binding.mjs` (18/18), `node scripts/preparation_binding_probe.mjs verify all` (12/12 resource manifests), and `node scripts/preparation_binding_probe.mjs audit all` (12/12), plus `git diff --check` (only pre-existing CRLF-related diagnostics in unrelated `src/lib/host/storage.ts`). P0 contains the detailed real-pi probes, binding verdicts, and remaining limits; read it and the plan before coding. Reuse `bindings.json`, `assertRouteAvailable`, `resolveRoots`/`checkToolCall` and the private workspace model; don't modify source skills/upstream files.
- Core U1–U7 and Fusion F4 have separate reports; neither report substitutes for Idea Preparation acceptance. Existing tree is intentionally very dirty. Preserve every existing modification/untracked file and all test/runtime evidence. There is no active Porch writer at dispatch (checked immediately before launch).
- Project Compose currently has only `egress-gw` and `env-controller` running; no rollout or service activation is in scope for P1.

## Implement exactly P1 (plan lines 99–105)

Covers R1–R7, R10–R11, KTD1/KTD6/KTD8; add preparation session/checkpoint, idempotent commands, and document-to-phase binding in `server/execution/preparation/` plus state-server API as necessary. Add `scripts/test_preparation_state.mjs`. Keep the core approval lifecycle unchanged. Read the relevant state-server, execution-store/domain, claims/board and P0 implementation before choosing seams. Do not create a parallel approval authority or treat chat text as approval.

The phase machine must define readiness from accepted/current requirements and plan plus all required SkillGates for the bindings actually used—not from a lead's final message or model confidence. A SkillGate must bind `{binding, digest, gate type, presented document version/hash (or explicit intent restatement), explicit user confirmation}`. Artifact/binding mutation invalidates only dependent gates; start-implementation readiness revalidates these gates together with the existing core approvals. Keep unsupported routes fail-closed by calling the P0 availability guard at route selection.

## Required scenarios (all must be real behavior tests)

1. Two concurrent/tab-equivalent `start` commands produce one preparation/session; repeated commands are idempotent and return the same durable outcome.
2. Version/hash-bound acceptances cannot be replayed against a different version/hash; no change to the existing core approval lifecycle.
3. Status/read-only question leaves documents and their hashes unchanged.
4. Changing intent invalidates the dependent plan/gates, without falsely accepting a replacement.
5. Early draft preserves explicit open questions and cannot become ready solely because the assistant ended.
6. Injected crash between durable document write and projection update recovers consistently after restart/replay (or leaves the session safely blocked; never phantom-ready/loss).
7. Stopping an answer/attempt cannot replace or authorize a newer document/attempt; retries/replays remain idempotent.
8. SkillGate missing, stale digest, changed document, and unsupported binding fail closed with actionable structured result.

Tests must exercise runtime behavior using production factories/state APIs and fake runtime/adapters plus deterministic crash injection. Do not test by grepping source text; no tautological assertions (`or True`). Add exact state/hash/revision assertions and prove no writes for read-only/refusal cases.

## Boundaries

- Only P1-owned changes in `server/execution/preparation/`, minimal state-server API/wiring required for P1, and `scripts/test_preparation_state.mjs`, plus the P1 report/deviation artifact. Do not edit P0-owned skill registry/bridge/probe unless a P1 integration request is unavoidable; if needed, document the request first in the report and implement only the narrow seam with a regression test. Do not alter `src/`, UI, approvals core lifecycle, shared unrelated modules, Compose, installed plugins/skills, or user state.
- Do not start P2, browser/P5, real skill probes beyond bounded P1 needs, or production rollout. No commits, pushes, publication, reset/clean/stash, deleting pre-existing files, or long/live suite beyond the plan's P1 deterministic Node suite.
- Keep this single shared checkout; no second executor/worktree. Do not overwrite existing dirty work. Do not create fake claims of browser/CLI/production acceptance.

## Completion and handback

Run `node --test scripts/test_preparation_state.mjs` and the necessary focused P1 regression tests; report exact command, count, duration, and output. Inspect your full diff and status against the tree you received; explicitly enumerate only your files and confirm unrelated baseline dirt was preserved. Save `docs/reports/agent-idea-preparation-p1.md` with `STATUS: DONE|PARTIAL|BLOCKED`, and sections `измерено / вывод / не измерено`, each required scenario and its test/evidence, exact files, known gaps, and next P2 dependency. Do not claim P1 accepted: parent will independently inspect the diff and rerun acceptance. End with `P1 ГОТОВ` only if implementation and its tests/report are complete; otherwise use `P1 ЧАСТИЧНО` or `P1 BLOCKED` with precise failing evidence.
