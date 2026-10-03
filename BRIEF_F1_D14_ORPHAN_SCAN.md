# F1 D14 follow-up — do not mistake unverifiable worker for gone

## Task
Fix one measured residual integration defect from the F1 D14 reaper work. This is an implementation task in the existing ACP UI checkout; make the smallest TDD change and deliver a scoped report. Do not claim F1 accepted: this slice is one D14 follow-up only.

## Verified state at dispatch
- Repo: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`, HEAD `58e4e120bd64ee6c5328c66f1ee1f0a6585ad0cb`.
- `porch delegate list --active --json` returned `[]` immediately before dispatch.
- The checkout is intentionally mixed/dirty: 154 paths with `git status --porcelain=v1 --untracked-files=all`; preserve every pre-existing change. Do not reset, clean, stash, checkout, or `git add -A`.
- F1 D14 work is already in the tree/commits. `node scripts/test_execution_environment.mjs` independently passed 193/193; the known residual is below.
- Product evidence: `server/execution/environment/container-runtime.mjs:707` currently computes `gone = st?.state !== 'running'`. The F1 D14 controller returns `state:'inspect_failed'` for non-404 Docker inspect errors and raw transitional states (e.g. `restarting`); these do NOT prove absence or a dead PID namespace.
- Both consumers treat `gone !== false` as positive proof: `server/execution/fusion/controller.mjs:264-267` and `server/execution/fusion/handoff.mjs:351-355` can resolve a delayed launch as orphaned if an inspect failure was surfaced as `gone:true`. This crosses from observability into durable attempt resolution; fail closed.
- Existing test commands: `node scripts/test_execution_environment.mjs`, `node --test scripts/test_fusion_controller.mjs`, `node --test scripts/test_fusion_handoff.mjs`.

## Exact ownership
Allowed write paths only:
1. `server/execution/environment/container-runtime.mjs`
2. Existing regression tests necessary to prove this exact behavior, preferably `scripts/test_execution_environment.mjs`; if consumer coverage requires the existing Fusion suites, only their relevant test file(s): `scripts/test_fusion_controller.mjs`, `scripts/test_fusion_handoff.mjs`.
3. `docs/tmp/2026.10.02_agent-fusion-f1_deviations.md` only to append the measured D14 follow-up row after it is fixed.
4. Write your result to `/tmp/acp-f1-d14-orphan-scan/REPORT.md` (not a repo product path).

Forbidden: every other repo path, especially `server/acp-runner.mjs`, scheduler/domain/core files, Compose/runtime configuration, `deploy/`, preparation/UI, Orchestrator and Swarm paths, service state, live containers, ports, external services, and all other agents' files.

## Required method
1. Record pre-edit SHA-256 and exact status for every allowed repo path; read the current code and caller semantics. Do not assume a state means gone merely because it is not `running`.
2. Add a tight RED-capable regression first: an inspect failure (`inspect_failed`), malformed/unknown state, and a transitional state must not yield positive `gone` evidence or let the `allGone` orphan-resolution gates in either consumer resolve the attempt. Keep confirmed `stopped`/`gone` semantics as the existing contract requires. Prove RED before changing production code.
3. Fix only the source of the false positive. Preserve the distinction between confirmed stopped/absent and unverifiable/transitional. Do not weaken timeout, fencing, or reaper safety checks.
4. Run the relevant regression tests plus all three exact commands listed above; capture full outputs, exit codes, elapsed time, and counts. `node scripts/test_execution_environment.mjs` must remain green. No Compose/browser/long live probes; this is a deterministic logic slice.
5. Self-review the exact diff and prove only allowed paths changed; compare pre/post hashes/status and preserve all baseline dirt.
6. Do NOT commit these paths if they were already untracked before your edits or if the baseline cannot be separated safely. Do not stage an entire pre-existing untracked source/test file just to create a commit. Report the precise commit boundary; otherwise make a scoped commit only if you can prove it contains only your own lines/files and nothing pre-existing.

## Report format
`STATUS: DONE | PARTIAL | BLOCKED`
- Root cause (measured, with file:line)
- RED then GREEN evidence (exact commands, exit codes, counts, elapsed)
- Files changed and ownership check (pre/post hashes/status)
- Commit hash, or why committing would falsely absorb baseline (no push)
- Remaining F1/Core gates; do not call whole F1/Fusion/Core accepted
- One-line final marker: `F1 D14 ORPHAN-SCAN FOLLOWUP: DONE|PARTIAL|BLOCKED`
