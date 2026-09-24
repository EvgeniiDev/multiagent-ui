# d4ff5be5 — the review cycle: severity counters, the `agent_tested` gate, minor → backlog

**STATUS: DONE** — `npm run build:web` green, `e2e_review` 50/50, `e2e_board`
21/21, `e2e_card_pipeline` 41/41, `e2e_roles` 35/35, `e2e_pm` 68/68, zero
pageerrors.

The review LOOP (developer → reviewer → fix, until every `critical`/`major`
finding is closed) lives in the role prompt files and the CLI agents' own
skills — the panel only makes the cycle's state visible and enforces the one
gate that is the panel's business: **a card does not become `agent_tested`
while a `critical` or `major` finding is open.**

## What was built

### Shared contract — findings as card artifacts, not panel state

- `.acp/cards/<id>/review_findings.json` — the structured review state both
  writers share:
  `{version, round, findings: [{id, round, severity, text, where, status,
  closedInRound}]}`. It rides the existing artifact-dir contract the pipeline
  already uses; no parallel store was added. `.acp/README.md` documents the
  shape.
- `.acp/roles/reviewer.md` (new) — the reviewer role prompt (Russian, matching
  `dev.md`'s style): the round protocol — read `boardctl show` + artifacts,
  write the prose report `05_review_r<N>.md` plus findings records, record the
  round with `boardctl review --round`, apply derived state with `--sync`,
  close findings with `--close`; last round escalates the model — carried as
  role `args` data; a failed run changes nothing.

### Role data — severity vocabulary + round limit are data

- `src/stores/roles.ts` — `ReviewRules {severities, blocking, backlog,
  maxRounds}` on `Role.review`, `DEFAULT_REVIEW_RULES` (`critical major minor
  nit` / blocking `critical major` / backlog `minor nit` / `maxRounds: 3`),
  `sanitizeReview` on load, validation on write (non-empty vocabulary,
  blocking/backlog ⊆ severities, `maxRounds ≥ 1`), and
  `reviewRulesForStage(stage)` used by every consumer — nothing about the
  vocabulary is hard-coded in a component.
- `src/features/roles/RolesSection.vue` — the role editor carries the four
  review fields (severities / blocking / backlog / max rounds) and the role
  row displays them; all empty = the role carries no review data and defaults
  apply.

### Panel stores

- `src/stores/review.ts` (new) — per-card review state fed by the artifacts
  loader: `parseReviewDoc` (findings normalized, malformed docs throw),
  `openCounts`, `gateRefusal` (refusal text naming each open blocking severity
  + count; an unreadable findings file fails the gate *closed* — the panel
  cannot verify nothing is open; a missing file does not block), and
  `applyDerived` — the round-limit flag: `round ≥ maxRounds` with blocking
  findings open → `blocked` + `review: round limit N reached with open
  findings (…)`; review-owned marks are cleared when the condition stops
  holding, foreign `blockedReason`s are never touched.
- `src/stores/artifacts.ts` — `doRefresh` reads `review_findings.json`
  through the existing fs bridge (excluded from the prose artifact list),
  distinguishes malformed content (`unreadable`) from transport errors, and
  resets review state when the card dir is gone.
- `src/stores/board.ts` — `MutationResult {ok, reason?}`; `reviewGateRefusal`
  checked in `setCardStatus`, `updateCard` (status patches), and the
  resumed-status path of `moveCard` — a card sent back and returned to
  reviewtest cannot quietly sit at `agent_tested` either. Refusals write a
  ledger entry and transition nothing.

### Panel UI

- `BoardCardItem.vue` — `data-testid="review-findings"` chip:
  `r3/3 crit 1 · maj 1 · min 1 · nit 0`, severity names/order and the round
  limit from the role's `review` data, `has-blockers` styling while a
  blocking severity is open.
- `CardDrawer.vue` — a **Review findings** block (round token, open-counts
  line, the gate note naming open blockers, the findings list with
  severity/status/round, the unreadable-error surface); status changes go
  through `setCardStatus` and a refusal alerts + snaps the draft back.
- `KanbanTab.vue` — the status-menu path surfaces the refusal reason instead
  of silently swallowing the click.

### `boardctl` — the second writer, same gate

- `boardctl review <id>` shows round/counts/gate + the findings table;
  `--round N` records the round; `--close FID` closes a finding
  (`closedInRound` stamped); `--sync` materialises each open backlog-severity
  finding as a backlog card (title `[sev] text`, `links` carrying
  `acp://card/<src>/finding/<fid>` — the finding's own id is the dedup key —
  plus `dependsOn → src` and the mirrored `blocks` on the source), and
  maintains the round-limit `blocked` flag on `review:`-owned marks only.
- `boardctl move`/`set --status` into `agent_tested` runs the same
  `reviewGateRefusal` — reading the findings file directly, so the CLI is
  bound by the same rule as the store.
- Atomicity is structural, same as `pmgraph`: findings file read +
  validation + severity-vocabulary check + the whole diff computation all
  precede the single rev-guarded board write; a no-change `--sync` raises
  `_SyncNoChange` inside the mutate fn so no PUT happens at all (no rev
  bump); a malformed file, missing file, unknown finding id, or bad `--round`
  exits non-zero with the board byte-identical.

## Verification

### Commands run

```
$ npm run build:web
…
dist-web/assets/index-BTMJGxbQ.js   542.44 kB │ gzip: 189.15 kB
✓ built in 2.90s
```

```
$ ~/.hermes/tools-venv/bin/python scripts/e2e_review.py
```

own state server on :25914, project `tmp-review-test/proj` holding real
`review_findings.json` files, real `boardctl` subprocess calls for the writer
legs, a `VITE_STATE_URL` test bundle on :25979 driven by playwright with the
host fs API stubbed from the project dir. Output tail:

```
PASS  failure[bad round]: board byte-identical
PASS  no findings file -> agent_tested allowed
PASS  ui: drawer review block present
PASS  ui: drawer counts line  (3 open — critical 1 · major 1 · minor 1 · nit 0)
PASS  ui: drawer gate note names the open blockers  (open review findings — 1 critical, 1 major)
PASS  ui: blocked reason field shows the review: mark  (review: round limit 3 reached with open findings (1 critical, 1 major))
PASS  ui: drawer move to agent_tested REFUSED via alert  (open review findings — 1 critical)
PASS  ui: status select snaps back to in_progress  (in_progress)
PASS  ui: C2 still in_progress on the board
PASS  ui: zero pageerror events

50/50 assertions passed
```

Requirement-by-assertion map (all PASS):

- **1 crit + 1 major open → refused, naming both** — `boardctl move …
  agent_tested` → `agent_tested refused: open review findings — 1 critical,
  1 major (review_findings.json)`; `set --status` refused identically; the
  panel drawer refuses via alert with the same text.
- **after closing both → move succeeds** — `--close f-crit --close f-maj`
  stamps `closed`/`closedInRound`, the open `minor` does not block,
  `move → agent_tested` lands.
- **minor never blocks + exactly one linked backlog card** — `--sync`
  creates one `backlog` card with the `acp://card/<src>/finding/f-min` link,
  `dependsOn → src`, `blocks ∋ child` on the source; a second `--sync`
  prints `in sync — nothing to change` and the board rev does not move.
- **round increments + limit flags blocked with reason** — `--round 3` then
  `--sync` → `blocked` with `review: round limit 3 reached with open
  findings (1 critical, 1 major)`; the panel's own `applyDerived` produces
  the identical mark on a card the CLI never touched (C6 leg).
- **failing run → board byte-identical** — malformed findings, no findings
  file, unknown finding id, `--round 0`: non-zero exit, `board.json.json`
  compared byte-for-byte before/after.
- **panel renders the counts** — `data-testid="review-findings"` chip
  assertions on two cards + absence on a clean card; drawer block
  (`review-block`/`review-round`/`review-counts`/`review-gate`/
  `review-list`) assertions.
- **boardctl bound by the same gate** — the move/set legs above are real
  CLI subprocesses against the real state server.

Adjacent suites (unchanged behaviour holds):

```
$ python3 -m http.server 25999 --bind 127.0.0.1   # dist-web, for e2e_board
$ ~/.hermes/tools-venv/bin/python scripts/e2e_board.py        → 21/21
$ ~/.hermes/tools-venv/bin/python scripts/e2e_card_pipeline.py → 41/41
$ ~/.hermes/tools-venv/bin/python scripts/e2e_roles.py         → 35/35
$ ~/.hermes/tools-venv/bin/python scripts/e2e_pm.py            → 68/68
```

`e2e_review` is registered in `scripts/e2e_all.py` (`("review",
scripts/e2e_review.py, None)` — self-contained, serves its own bundle).

## What could not be verified live

- The **real deploy fs bridge** (`deploy/acp-ws-bridge.mjs`) implements only
  `/api/fs/root` + `/api/fs/list` — it has no `/api/fs/read`. The panel path
  was verified against an e2e stub implementing the full `src/lib/fsApi`
  contract (same seam the card-pipeline suite uses); on a desktop/Tauri
  host the native bridge is the real reader. If a deployment exposes only
  the list-only bridge, findings will not load and the gate treats the
  state as unknown (nothing known open). Worth a follow-up: extend the
  deploy bridge or fold findings into `list`.
- **The review loop itself** (developer → reviewer → fix rounds) is
  role/agent behaviour — the e2e drives the state transitions through
  `boardctl` exactly as the role prompt prescribes; no real agent ran the
  loop end-to-end here.
- `updateCard` refusal semantics: a patch carrying both `status` and other
  fields applies the other fields and refuses only the status — deliberate
  (the gate's contract is the `agent_tested` transition, not the whole
  patch); noted for review.
