# PM wakeup — the pm role wakes itself on a timer

**STATUS: DONE** — `e2e_pm_wakeup` 37/37, `e2e_pm` 68/68, `test_pmgraph`
34/34, `npm run build:web` clean.

## Fork in the road — what was chosen and why (one line)

Variant **(1) systemd timer** won: the same selectivity as a state-server
hook (changed-since-last-run + quiet window + live-claim gates) without
turning the state server — the service everything else depends on — into a
manager of long-lived LLM child processes.

## What was built

- **`server/acp-pm-wakeup.mjs`** (new, node-only, zero deps) — one guarded
  pm run per invocation. Gates, in order:
  1. `pm-wakeup.json` `running` slot held by a live pid → `running` skip
     (the slot is taken rev-safely, so a timer tick and a hand invocation
     can never double-run);
  2. board has no cards → `empty-board` skip;
  3. `sha256(board.data)` equals the post-run snapshot stored in the
     wakeup doc → `unchanged` skip — the quiet-night property: a skipped
     tick is a couple of GETs, no writes, no model calls, no ledger rows;
  4. `board.json` written inside `PM_QUIET_MIN` (default 10) → `settling`
     skip — a burst of edits earns ONE run after it settles;
  5. a live `claims.json` entry owned by the pm role (a manual dispatch
     in flight) → `pm-claim-live` skip;
  6. the newest `role:"pm"`/`kind:"pm"` ledger entry is younger than the
     quiet window (someone just ran pm by hand) → `pm-active` skip.
  A run that fires spawns the role exactly like `acp-runner` does —
  `roles.json` entry id `pm`, `role.cli` + `role.args` (+ `models.execute`
  substitution) + `--prompt-file <brief>`, `role.timeoutMin` →
  SIGTERM/SIGKILL — but with no card and no claim. The brief says there is
  no trigger card, names the scope (`PM_SCOPE`, default `--all`) and the
  report path. Artefacts live in `.acp/pm/wakeup/<session>/` (brief.md,
  run.log, pm-report.md; last 20 runs kept). `BOARD_URL=STATE_URL`,
  `SESSION_ID=pmwake-*`, `PM_WAKEUP_RUN_DIR` are exported for the child so
  its `boardctl`/`pmgraph` calls hit the same server. Start and end
  (`exit`, `dur`, `verdict` sniffed from the report's STATUS line, log
  path) go to `activity.json` as `kind:"pm"` entries with `role:"pm"`,
  `agentName:"pm-wakeup"`. After the run the board hash is re-read and
  stored — a pm run that edited the board cannot retrigger itself. A
  missing `pm` role costs one honest ledger row per board change, then
  silence; a crashed/timed-out run is recorded with its exit code and the
  consumed hash means the next tick does not hammer a retry. `--force`
  skips gates 2-6 (never the live slot). Exit: 0 ran/skipped, 2 no pm
  role, 3 state server unreachable.

- **`docs/acp-pm-wakeup.service` + `docs/acp-pm-wakeup.timer`** (new,
  reference user units next to the existing `docs/acp-*.service`
  convention) — oneshot service + timer (`OnBootSec=10min`,
  `OnUnitInactiveSec=30min`, `Persistent=true`). **Not enabled** — arming
  it is the owner's call:

  ```bash
  install -m 0644 docs/acp-pm-wakeup.{service,timer} ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now acp-pm-wakeup.timer
  ```

  Also needs a `pm` entry in `roles.json` (none exists in the live config
  today — only `dev` is registered).

- **`docs/lan-deployment.md`** — a short "PM wakeup timer (optional)"
  section with the enable commands.

- **`.acp/roles/pm.md`** — minimal edits only: trigger-less runs take the
  scope from the brief (label or `--all`), `boardctl show` is skipped when
  there is no card, and the report goes to the path the brief names.
  No duties added.

- **`scripts/e2e_pm_wakeup.py`** (new) + one line in
  `scripts/e2e_all.py` — own state server (:25918), scratch project and
  PM_WAKEUP_DIR under `tmp-pm-wakeup-test/`, stub role CLI that does a
  real `pmgraph apply`. Legs: fire (run happened with zero cards claimed,
  ledger rows carry `role:"pm"`, board gains exactly the safe-set changes,
  C untouched), idle (unchanged → skip, zero new rows), settle (quiet
  window defers, then fires), claim gate (live pm claim defers, expired
  does not), failure (stub exit 3 → wrapper non-zero, end row audited,
  board byte-identical, next tick silent), no-role (exit 2 + one row +
  silence until role appears), force + live slot.

## Verification output (real)

### `~/.hermes/tools-venv/bin/python scripts/e2e_pm_wakeup.py` — 37/37

```
PASS  fire: wakeup exits 0
PASS  fire: stdout reports the run  ({"ran": "pmwake-muh8pd6b", "exit": 0, "verdict": "DONE"})
PASS  fire: ledger rows carry role pm  (5 pm rows)
PASS  fire: wakeup end row: exit=0 + verdict DONE
PASS  fire: pmgraph's own run row shares the session
PASS  fire: mirror repaired — B.blocks += A
PASS  fire: A pm-blocked on the unfinished dep  (pm: blocked by wk-bbbb)
PASS  fire: no card was claimed (not a card run)
PASS  idle: second tick skips 'unchanged'
PASS  idle: zero new ledger rows
PASS  settle: fresh edit inside quiet window skips  ({"skipped": "settling"})
PASS  claim: live pm claim defers the auto-run  ({"skipped": "pm-claim-live"})
PASS  failure: board doc byte-identical
PASS  failure: next tick does not hammer — 'unchanged' skip
PASS  no-role: exit 2 + 'no-role' payload
PASS  slot: live slot beats even --force
…
37/37 assertions passed
```

### `~/.hermes/tools-venv/bin/python scripts/e2e_pm.py` — 68/68

```
…
PASS  empty plan: exit 0 but board byte-identical
68/68 assertions passed
```

### `~/.hermes/tools-venv/bin/python scripts/test_pmgraph.py`

```
Ran 34 tests in 0.004s
OK
```

### `npm run build:web`

```
vue-tsc --noEmit && vite build --mode web
✓ built in 4.00s   (no type errors)
```

## Honest list: not verified

- **No real LLM run** — the e2e drives a stub CLI that does a genuine
  `pmgraph apply`; an actual `devin -p --prompt-file …` wakeup session was
  not spawned (cost + the contract is the runner's own args layout).
- **systemd timer never fired** — units are shipped, not enabled; the
  service's ExecStart line was syntax-matched to the runner unit, not run
  under systemd (user-level `systemd-analyze verify` not performed).
- **pmgraph-apply self-retrigger** — covered by construction (post-run
  hash snapshot) but not by a dedicated leg where pm's own write is the
  only change between ticks.
- **Run-overlap with a manual F10-style card run landing mid-wakeup** —
  gates check a live claim before the run; a claim *starting* during the
  wakeup's own run is not serialized (same race window the runner itself
  has between passes).
- Prompt content for the agent (`pm.md` wording on scope/proposals) —
  owner said the content discussion comes separately.
