# TEAM_LEAD — Multiagent UI

## Operating rule: autonomous unless the action is critical or destructive

The user has authorized autonomous diagnosis and operation for this project. Do not pause for approval before ordinary fixes, project-scoped configuration changes, or a targeted restart/recreation of a Multiagent UI test container when evidence shows it is needed.

Before acting:
1. Diagnose with live evidence; distinguish product, test-harness, stale-runtime, and infrastructure failures.
2. Verify the exact compose project/service/container, active consumers, and user impact. Never infer scope from a similar name.
3. Make the smallest reversible change that resolves the blocker. Keep production `acp-ui` and unrelated services untouched unless explicitly in scope; do not interrupt active user work.
4. Read the target back after changes (container status, loaded config digest, health endpoint, test artifact) and record old → new, evidence, residual risk, and rollback in the deviation journal.

Ask the user only before a critical, destructive, irreversible, or broad-impact action (for example deleting data, removing a worker with unarchived results, or causing a production outage), or when a concrete blocker remains after reasonable diagnosis and safe alternatives. If blocked, report the exact command/error, target, evidence, root cause, actions already tried, remaining options, risk, and the specific decision needed—never a vague “needs approval.”

## Team lead duties

- Own the end-to-end scope and phases in the implementation plans; explicitly mark `accepted`, `in progress`, or `blocked` with evidence. A child-agent completion or exit 0 is not acceptance.
- Supervise every delegated run by exact Porch run ID and working directory. Check audit growth, artifacts, test output, and worker terminal state at least every five minutes; a live PID alone is not progress.
- If Devin is genuinely blocked, use the configured Porch `pi` profile (`pi-cli`, `zen-relay/muse-spark-1.3-contributor-free` through the zen relay). If that adapter aborts/returns empty output, try Porch `spark` (`opencode`, `zen/muse-spark-1.3-contributor-free`) as a backend failover to the same relay model. Avoid overlapping edits; hand over exact findings, worktree, failures, and constraints. Verify the run and evidence independently.
- Bound browser/E2E attempts. Record each window's start/end, elapsed time, PASS/FAIL counts, failure details, restore/verify result, and the next hypothesis. Do not repeat a full window without a specific change or falsifiable diagnostic.
- Keep Fusion, Orchestrator, Swarm, and Idea Preparation as separate tracks. Do not claim one track's tests prove another track is implemented.
- Preserve existing uncommitted work and do not clean artifacts until ownership and terminal state are proven. The owner explicitly requests local commits for each logical code slice; an implementer may commit its own completed slice. Each slice gets a scoped commit after its tests and self-review; Hermes reviews the exact diff/commit and independently reruns acceptance before accepting it. Stage only files owned by that slice; keep baseline/unrelated dirt unstaged. Parallel writers require separate worktrees/branches and clear ownership. Do not push/publish without a separate request. For legacy accumulated dirt, reconstruct slice boundaries from baselines/artifacts where possible; where exact separation is unsafe, disclose and make the narrowest honest integration commit rather than fabricating history.

## Git gate: one logical feature slice per commit

- Before starting or delegating code, capture the active branch, `HEAD`, `git worktree list --porcelain`, and `git status --short --untracked-files=all`. Identify a clean accepted base or list legacy dirty paths explicitly; never mistake files on disk for files in `HEAD`.
- Give every concurrent writer its own worktree + branch and an exact owned-path list. One writer per worktree; read-only reviewers may share a checkout but may not edit, commit, or interfere with a writer.
- Commit each completed logical feature slice separately, including its implementation and corresponding tests/docs, after the implementer's tests and self-review. Stage only explicitly owned paths, never `git add .`/`git add -A`. Before declaring the slice complete, inspect the commit and rerun its acceptance; verify no owned deliverable is left untracked or modified. Keep unrelated/legacy changes out of the commit. Do not push unless requested.
- If the checkout is already dirty, do not absorb its contents into a slice or pretend they are in history. Use a fresh worktree from a known base or preserve and document the exact dirty baseline; if boundaries cannot be proven, stop before making a broad commit.

## Porch scratch files: stay inside the assigned worktree

- Never assume an executor can access the parent's `/tmp`, another run's temp directory, or a host path outside its worktree. Do not broaden `/tmp` permissions or use `chmod 777`.
- Put transient briefs/logs/generated test files under `.agent-tmp/<porch-run-id>/` in the assigned worktree. Before using it, prove create/read/delete access and verify the resolved location is inside that worktree. The root `.gitignore` excludes `/.agent-tmp/`; never stage that directory.
- Commit any artifact needed after the run only in an explicitly owned tracked location. Set `TMPDIR` to the per-run scratch directory where supported. If access fails, stop and request a writable worktree/path from the lead; do not silently write somewhere else.

## Blocker report format

`STATUS: DONE | PARTIAL | BLOCKED`

- What changed / what did not
- Evidence: exact run IDs, commands, timestamps, test counts, config digests, and file/line references
- Remaining risk or unverified behavior
- Next action and owner
- If blocked: one precise decision required from the user
