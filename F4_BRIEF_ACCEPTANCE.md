# F4 acceptance continuation — single-writer task

You are the sole writer for this run. Repo/workdir: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. This checkout intentionally has a large pre-existing dirty/untracked worktree from ACP UI delivery; do not reset, clean, stash, commit, push, or publish anything. Scope is ONLY current Fusion F4: managed card/drawer + Workflow side panel + real browser E2E + release record. Do not claim or test Orchestrator, Swarm, Idea Preparation, or other modes as accepted.

## Proven state / handoff
- Prior executor `run_golden-tundra-6017` (Devin) completed 2026-10-02 11:50:53Z, exit 0, but F4 was NOT accepted: there was no confirmed green browser suite after stale env-controller config.
- D11 is recorded in `docs/tmp/2026.10.02_agent-fusion-f4_deviations.md` around lines 225–265. Before restart, the controller reported stale digest `b0a68a00…`; on-disk `deploy/execution/environment.config.json` hashes to `93aa01e9aa43ef6b35ffa641d4962b2e08c87087cd37c0cee826b8524ca9c68c`. Existing D11 says restart had been pending, but a later verified restart was performed on 2026-10-02 around 12:14Z, solely for compose project `acp-ui-agent-modes`, service `env-controller`; container is `acp-ui-agent-modes-env-controller-1`, StartedAt `2026-10-02T12:14:31.795Z`, RestartCount 0. The on-disk compose project lists only `state`/`stt`/bridges/cron/runner/web/https-front; the F1 controller is a separately profiled service in this project. Production project `acp-ui` must remain untouched.
- A fresh verification attempt using an incorrect guessed socket path `/run/env-controller/control.sock` failed `ENOENT`; DO NOT treat that as controller failure. Discover the actual mounted socket path from compose/env-controller source/config or existing smoke helpers, call `controller.ping()` read-only, and verify the returned config digest equals the on-disk digest. Do not restart again absent a new evidence-based reason.
- Pi Porch run `run_ivory-pine-7754` failed terminally in 6 sec, exit 1, `empty final text` (2026-10-02 12:38:48Z); its audit shows it read TEAM_LEAD.md then model request aborted. This justifies this ONE OpenCode `spark` failover via the same relay. There are currently no active Porch runs (`porch delegate list --active --json` returned `[]`). Do not launch any parallel writer or second browser test.
- Prior window history and known harness corrections are documented in the F4 deviation journal (D1–D11). Specifically D11 was the only suspected remaining runtime blocker. Existing previous windows were not accepted: older windows had PASS counts but failed/timeouts, and the latest Devin completion had no confirmed green run after the restart.
- Controller verification snapshot at 12:55Z: compose `env-controller` container is Up, compose project label `acp-ui-agent-modes`; controller ping still needs correct endpoint verification.

## Required work
1. Re-read `AGENTS.md`, `TEAM_LEAD.md`, F4 plan section, deviation journal, and inspect current git status before changes. Preserve all existing content.
2. Read the browser test harness and its launcher. Confirm exact venv/interpreter and bounded timeouts. Do not run the browser suite until confirming no other active writer/test/window. Do not touch production services/processes; only the test overlay/window is in scope.
3. Verify controller digest through the correct read-only control interface and compare to disk. If it matches, proceed. If it does not, stop before test/restart and report exact evidence and the narrow options; no repeated blind restarts.
4. Run one clean end-to-end F4 browser window with the known controller digest and corrected harness/model settings. The previously used launcher was `python3 scripts/u7_run.py --self-run-id <this-run-id> --phases fusion,browser-fusion`; confirm it is still correct. It must capture suite PASS/FAIL counts, detailed failures, duration, window/run IDs, and automatic restore/verify results. Do not edit code during measurement. The F4 window itself is the explicit new hypothesis test: D11 restart fixed stale allowlist.
5. After test window terminal: independently inspect its raw logs/artifacts and run status; confirm `restore:0`, `verify:0`, and that runtime/ports/compose state returned to baseline. Build with host command `npm run build:web` (never in Docker). Run relevant deterministic Fusion suites if feasible and bounded: inspect package/scripts and previous reports first.
6. Independently inspect the diff relevant to F4; do not commit/push/publish. Update only the F4 deviation journal/report with factual measured evidence and honest unresolved scope. Do not overwrite unrelated files. If the acceptance report already exists, append/update minimally.

## Acceptance criteria (all required; otherwise PARTIAL/BLOCKED)
- Browser suite after D11 restart completed normally (not timeout/kill) with **0 FAIL**, and report real PASS count and run/window IDs.
- Runtime restore and verify both exit 0; production `acp-ui` container state remains unchanged.
- Controller ping digest matches the current on-disk `environment.config.json` digest.
- Host `npm run build:web` exits 0.
- Relevant deterministic Fusion tests exit 0, with explicit counts.
- F4 report and deviation ledger accurately distinguish measured evidence, inference, and unverified items; git tree preserved; no commit/push.
- Do not represent any non-F4 track as accepted.

## Constraints
No production restart, no unrelated process killing, no data/network/container cleanup unless individually proven owned by dead F4 windows and necessary; no deletions merely to tidy. If any proposed cleanup is destructive or ownership is ambiguous, do not do it. Keep one writer only. Preserve all dirty/untracked work. Report `STATUS: DONE|PARTIAL|BLOCKED`, exact UTC times, commands, counts, IDs, digests, restore result, changed files, residual risk, and next owner.
