# W14 — starter role files: orchestrator + plan-writer

**STATUS: DONE** — both prompt files written and *executed for real*: one full
live pipeline run (backlog → spec → plan → dev → reviewtest → agent_tested) on a
real backlog card, plus a 27/27 e2e suite proving the role records parse through
the panel's real store and that every `promptFile` exists.

## What changed

- **`.acp/roles/orchestrator.md`** (new) — the orchestrator prompt, Russian,
  same style as `dev.md`/`pm.md`/`reviewer.md`. Inputs: card id + artifact dir
  from the runner's `00_brief.md`. Checkable steps: `boardctl show/claim/move`
  (claim under `${BOARD_AGENT:-orchestrator}`, sessionId shared with every
  delegate row), write `01_spec.md`, write the plan-writer brief
  `02_brief_planwriter.md`, `boardctl delegate` + `scripts/porch-dispatch` +
  `porch delegate wait` for each subagent, dev briefs `04_brief_dev_<n>.md`
  that name `02_plan.md`, reviewer brief `05_brief_reviewer.md`, the
  critical/major fix loop driven by `boardctl review`, `review --sync`, and
  the final `move reviewtest agent_tested` + `release`. Never-list: no
  `done`/`accepted` moves (human-only), no merge/push, no `boardctl set` on
  card substance, no touching other cards, no invented state — every step is
  proven by an artifact or a `boardctl`/`porch` output line, failures end
  `boardctl block` + `STATUS: BLOCKED`.
- **`.acp/roles/plan-writer.md`** (new) — turns the card + `01_spec.md` into
  `02_plan.md`: executor slices (1..N, no shared files between slices),
  ordered minutes-sized steps each with a check, an acceptance→verification
  command per criterion, risks, open questions. Read-only recon; writes the
  plan file only; `STATUS: DONE|BLOCKED` last line.
- **`.acp/README.md`** — the role DATA entries for the whole conveyor in the
  documented shape `{id, cli, args, promptFile, maxConcurrent,
  pollIntervalSec, timeoutMin, maxRetries}` (+ `review` for the reviewer),
  and the `stageRoles` wiring `spec→orchestrator, plan→plan-writer,
  dev→dev, reviewtest→reviewer`.
- **`scripts/e2e_role_files.py`** (new) + registration in `scripts/e2e_all.py`
  — the Job-1 contract check below.

## Job 1 — the files are the contract the panel reads

`e2e_role_files.py` runs its own `acp-state-server` on **25961**
(`STATE_DIR=tmp-rolefiles-test`, gitignored) and serves `dist-web` on **25960**;
the page's `:25900` traffic is proxied to the suite's server — the live host
service is never touched. It seeds the five documented role records and asserts
through the REAL panel store (the page's `window.__roles`):

- every record parses on the load path (`sanitizeRole`): one role row each,
  `role-promptfile-<id>` shows the file;
- `stageRoles` parses: `roleForStage` maps spec/plan/dev/reviewtest;
- the reviewer's `review` block round-trips (blocking/backlog ⊆ severities);
- `addRole` (`validateRole`) accepts a well-formed record and persists it to
  `roles.json` on the state server;
- rejects: `cli` outside KNOWN_CLIS, empty `promptFile` ("Prompt file path is
  required"), `review.blocking` outside the vocabulary;
- every record's `promptFile` exists on disk; both new files carry the
  required tool names and the `STATUS:` contract.

```
$ npm run build:web   # ✓ built in 3.01s
$ ~/.hermes/tools-venv/bin/python scripts/e2e_role_files.py
PASS  prompt file exists for role 'orchestrator' (.acp/roles/orchestrator.md)
PASS  prompt file exists for role 'plan-writer' (.acp/roles/plan-writer.md)
PASS  prompt file exists for role 'dev' (.acp/roles/dev.md)
PASS  prompt file exists for role 'pm' (.acp/roles/pm.md)
PASS  prompt file exists for role 'reviewer' (.acp/roles/reviewer.md)
PASS  orchestrator names boardctl
PASS  orchestrator names scripts/porch-dispatch
PASS  orchestrator records subagents via boardctl delegate
PASS  orchestrator never moves past reviewtest (done/accepted banned)
PASS  plan-writer writes .acp/cards/<id>/02_plan.md
PASS  plan-writer ends with the STATUS token contract
PASS  orchestrator ends with the STATUS token contract
PASS  README documents orchestrator + plan-writer records
PASS  every seeded role record parses into a role row  (missing: [])
PASS  promptFile shown for 'orchestrator'  (.acp/roles/orchestrator.md)
PASS  promptFile shown for 'plan-writer'  (.acp/roles/plan-writer.md)
PASS  promptFile shown for 'dev'  (.acp/roles/dev.md)
PASS  promptFile shown for 'pm'  (.acp/roles/pm.md)
PASS  promptFile shown for 'reviewer'  (.acp/roles/reviewer.md)
PASS  stage->role binding parsed (spec/plan/dev/reviewtest)  ([['spec', 'orchestrator'], ['plan', 'plan-writer'], ['dev', 'dev'], ['reviewtest', 'reviewer']])
PASS  reviewer 'review' block round-trips through the store  ({"severities": ["critical", "major", "minor", "nit"], "blocking": ["critical", "major"], "backlog": ["minor", "nit"], "maxRounds": 3})
PASS  addRole accepts a well-formed record  ({"ok": true, ...})
PASS  accepted role persisted to roles.json on the state server  (['orchestrator', 'plan-writer', 'dev', 'pm', 'reviewer', 'qa-live'])
PASS  cli outside KNOWN_CLIS rejected  (cli must be one of: hermes, opencode, devin, pi, codex)
PASS  empty promptFile rejected  (Prompt file path is required)
PASS  review.blocking outside the vocabulary rejected  (review.blocking: bogus not in severities)
PASS  zero pageerrors
27/27 checks passed
```

## Job 2 — a REAL orchestrator run on a real backlog card

**Card:** `344b978a` «docs/control-center-roles-requirements.md описывает
старую доску» — copied verbatim (same id/fields) from the live board.

**Isolation (deliberate):** the run was pointed at a dedicated state server
`:25916` (`STATE_DIR=tmp-roles-test/state`) seeded with the card copy, a
`projects.json` resolving `acp-ui` to a scratch worktree
`~/projects/acp-ui-w14-orchrun` (branch `w14/orchrun` off `c9b817b`), and the
documented `roles.json`. The live board on `:25900` and the real project
checkouts were NOT touched — running a pipeline on the owner's live board
mutates a real card and a real tree; the mechanics are identical either way.

**Launch (the same command shape the runner uses):**

```
cd ~/projects/acp-ui-w14-orchrun
BOARD_URL=http://127.0.0.1:25916 BOARD_AGENT=orch-w14 \
  SESSION_ID=orch-344b978a-live ACP_PROJECT_PATH=$PWD \
  devin -p --model swe-2-max --permission-mode dangerous \
      --prompt-file .acp/cards/344b978a-…/00_brief.md
```

**Transcript evidence (tail of the orchestrator's own log):**

```
Plan-writer finished. Verifying the plan artifact.
Plan is valid: one slice, exact file, verification commands per acceptance, ends with STATUS: DONE.
The per-run state server on :25916 died (state dir confirms it held my board). Restarting it with the same STATE_DIR and PORT.
Server restored with state intact (card plan/in_progress, my claim alive). The failed call was the delegate-end + moves — re-recording now.
Dev finished. Verifying the artifacts myself before accepting.
Review round 1: CHANGES_REQUIRED — 1 major + 2 nits. Verifying artifacts and review state.
f-001 is a real error — setCardFlag doesn't move the card. Entering the fix loop: briefing dev with the finding IDs.
All findings closed, gate clear. Dispatching reviewer round 2 with a fresh context.
…
STATUS: DONE
```

**Stage ledger — only pipeline-allowed moves (`events --card`):**

```
12:07:16 claimed by orch-w14 for 3600s (session orch-344b978a-live)
12:07:20 moved backlog → spec; status - → in_progress
12:08:08 status in_progress → done
12:08:08 moved spec → plan; status done → in_progress
12:14:12 status in_progress → done; moved plan → dev
12:23:39 status in_progress → done; moved dev → reviewtest
12:31:01 review: f-001 closed; f-002 closed; f-003 closed
12:35:54 status in_progress → agent_tested
12:35:54 claim released by orch-w14
```

The card ended `reviewtest / agent_tested` — never `done`/`accepted`
(human-only, per the role's never-list) — and the claim was released.

**Delegate rows — every subagent in the ledger (`events --kind delegate`),
keyed to `sessionId: orch-344b978a-live`:**

```
plan-writer  running  02_plan.md для 344b978a
plan-writer  failed→retry  glm run failed: opencode backend 401; retrying with devin
plan-writer  done     02_plan.md written by devin run_dusty-cedar-be84; verified STATUS: DONE
dev          running  ломтик 1: docs/control-center-roles-requirements.md
dev          done     devin run_ruby-glacier-3ecc; doc rewritten, A1–A4 pass
reviewer     running  ревью раунд 1
reviewer     failed→retry  deepseek 401 — retrying reviewer with devin fresh context
dev          running  круг починок r1: f-001..f-003
dev          done     devin run_brisk-sable-b21d; f-001..f-003 fixed and closed
reviewer     running  ревью раунд 2
reviewer     done     devin run_nordic-falcon-81f2: APPROVE, 0 open findings
```

**Artifacts** (`~/projects/acp-ui-w14-orchrun/.acp/cards/344b978a-…/`, copies
in `tmp-roles-test/card-artifacts/`): `00_brief.md`, `01_spec.md`,
`02_brief_planwriter.md`, **`02_plan.md`**, `04_brief_dev_1.md`,
`04_brief_dev_2.md`, `04_impl_log.md`, `05_brief_reviewer.md`,
`05_review_r1.md`, `05_review_r2.md`, `review_findings.json`, `06_handoff.md`.

- The dev brief **names the plan file** — `04_brief_dev_1.md` line:
  «**План**: `.acp/cards/344b978a-…/02_plan.md` — прочитай целиком, исполни
  ломтик 1» (Job-2 requirement).
- The dev's real diff rewrote the 7-column table into the 6-stage
  `BOARD_STAGE_IDS`/`STAGE_STATUSES` model in
  `docs/control-center-roles-requirements.md`.
- Review round 1 produced `review_findings.json` — 1 major + 2 nits with
  file:line evidence; f-001 is a genuine catch (it cites
  `setCardFlag`/`LEGACY_STAGE_MAP` correctly). Fix round closed all three
  (`closedInRound: 1`), round 2 → `APPROVE`, `boardctl review --sync` →
  "in sync — nothing to change", gate `clear`.

**Honest deviations seen during the run** (all in the ledger + `06_handoff.md`):

- All `opencode→anymodel` porch agents (glm, deepseek, …) returned
  `401 API key required` — plan-writer and reviewer fell back to `devin`
  runs; the reviewer ran as a *separate fresh-context* devin run, which the
  orchestrator flagged in the handoff as the constraint behind the
  "different agent" rule.
- The seeded `:25916` state server died twice between calls; the
  orchestrator restarted it against the same `STATE_DIR`, verified the board
  was intact, and re-issued the lost calls — no state invented, no silent
  failure.

## What is NOT verified live

- **The panel runner (`acp-runner.mjs`) did not launch these roles** — the
  run was launched by hand with the runner's exact command shape
  (`devin -p … --prompt-file <brief>`). The runner's own poll→claim→spawn
  path is another workstream's card; the role records here are the data it
  reads.
- **`hermes`-CLI roles were not exercised** — the documented `reviewer`
  entry uses `cli: hermes` for variety; the live run used `devin` for every
  subagent because the anymodel backend was down (401). The record parses
  and is runner-shaped, but no hermes run was observed.
- **`porch delegate wait` on the live board** — subagent dispatch was real
  (porch run_ids above), against the suite server only.
- The scratch worktree `~/projects/acp-ui-w14-orchrun` (branch `w14/orchrun`)
  is left as evidence: `git worktree remove` + `git branch -D w14/orchrun`
  cleans it; the `:25916` state dir is `tmp-roles-test/state` (gitignored).
