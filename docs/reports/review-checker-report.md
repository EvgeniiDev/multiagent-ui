# cc/w15-checker — the review-checker role: verifying blocking findings before they gate

**STATUS: DONE** — `npm run build:web` green (vue-tsc 0), new suite
`e2e_review_checker` 39/39, `e2e_review` 50/50, `e2e_pm` 68/68,
`e2e_all` 20/21 suites green (the one failure is a pre-existing
calendar-dependent `e2e_dash_math` fixture, unrelated — see below), zero
pageerrors.

A review's blocking findings gated the card the moment the reviewer wrote
them — a FALSE major cost a whole extra dev round and nobody checked whether
the reviewer was right (`docs/orchestration-knowledge.md` §2.7/§4,
`docs/orchestration-upgrades.md` §1: «чекер ревьюера, который смотрит чуть
сверху, насколько ревьювер прав про блокеры»). This workstream inserts a
verification pass between review and the `agent_tested` gate: the gate still
refuses on confirmed critical/major — it is a check, not a loosening.

## What was built

### Contract — verdicts as a card artifact, append-only

- `.acp/cards/<id>/review_verdict.json` —
  `{version, verdicts: [{findingId, verdict, reason, checker, at}]}` where
  `verdict ∈ confirmed | rejected | disputed`. Append-only: the LAST verdict
  per `findingId` wins, so a re-check lands a newer row without editing
  history. The findings file stays the reviewer's/developer's — the checker
  never touches it.
- Semantics (identical in the store and `boardctl`): `confirmed` and
  `disputed` keep blocking; `rejected` stops blocking but stays in history
  with reason + checker; NO verdict keeps blocking (unvetted ≠ false); a
  verdict file that exists but cannot be parsed fails the gate CLOSED —
  rejections cannot be verified, so every open blocker counts, exactly the
  rule a malformed findings file already follows.
- `.acp/README.md` documents the file + the `proposed:` ledger convention.

### Role prompt

- `.acp/roles/review-checker.md` (new, Russian, matching the other role
  files): input is `boardctl show` + `boardctl review` + the findings file;
  for each OPEN blocking-severity finding verify the claim against the code
  and write one verdict + one-line reason via `boardctl review-check`; no
  verdict → finding still blocks; `disputed` is the honest "cannot decide"
  that goes to the human. Behaviour lives in the file, not in panel code.

### Store

- `src/stores/review.ts` — `ReviewVerdict`, `VERDICT_FILE`,
  `parseVerdictDoc` (entries with no `findingId` or a verdict outside the
  vocabulary are skipped — an unrecognized word never clears a blocker;
  malformed docs throw), `verdictFor` (latest row per findingId; `null`
  when unvetted OR when the verdicts file is unreadable — nothing trusted),
  `blockingCounts` (open AND not-rejected per severity), `gateRefusal`
  re-counted on `blockingCounts` with a `; verdicts unreadable (…)` suffix
  when applicable, and the round-limit flag in `applyDerived` now counts
  what still gates.
- `src/stores/artifacts.ts` — `doRefresh` reads `review_verdict.json`
  through the same fs bridge right alongside the findings file; malformed →
  `verdictsUnreadable` (fails closed), bridge error → honest `verdictsError`
  only, missing → empty. The verdict file is excluded from the prose
  artifact list like the findings file.

### CLI — the second writer

- `boardctl review-check <card> <fid> confirmed|rejected|disputed
  [--reason …] [--agent …]`: resolves the card, refuses when no findings
  file exists or the finding id is unknown (exit 2), refuses to append onto
  a malformed verdict file, appends the verdict, and logs the same fact to
  the activity ledger with `role=review-checker`. A `disputed` verdict's
  detail carries the `proposed:` prefix — the convention the Links tab's
  proposals list renders.
- `boardctl review` annotates each finding row with
  `[rejected by <checker>: <reason>]` etc., reports `verdictsUnreadable`
  in JSON mode, and prints a `! verdicts unreadable — no rejection trusted`
  line. `move`/`set` into `agent_tested` and `review --sync`'s round-limit
  check both count verdict-aware blockers.

### Panel

- `CardDrawer.vue` — every finding row carries a verdict badge
  (`data-verdict`, tooltip `checker: reason`); rejected rows are dimmed
  (`find-rejected`) but stay listed; `verdictsError` surfaces in the review
  block.
- `BoardCardItem.vue` — the review chip's blocker tint and counts follow
  `blockingCounts` (what still gates); rejected findings show as `rej N`.
- `LinksTab.vue` — `proposedEntries` now follows the `proposed:` detail
  prefix across ALL activity kinds instead of `kind === 'pm'` only, so the
  checker's disputed rows land in «Proposed — for a human». pm rows are
  unchanged (they already use the prefix).
- AgentsTab's `lastByRole` picks the checker rows up for free (same `role`
  field the dispatcher writes).

## Verified

### `boardctl review-check` (CLI legs of `scripts/e2e_review_checker.py`)

```
PASS  review-check rejected: verdict recorded, gate named  (ck-1-gat: f-falsemaj → rejected (kv.ts:41 already retries the PUT on 409); gate: refuse agent_tested (1 critical))
PASS  verdict file holds the rejected entry with reason + checker  ({"findingId": "f-falsemaj", "verdict": "rejected", "reason": "kv.ts:41 already retries the PUT on 409", "checker": "e2e-checker", "at": 1790317781864})
PASS  rejecting the false major: gate STILL refuses, names the critical  (boardctl: agent_tested refused: open review findings — 1 critical (review_findings.json))
PASS  confirmed critical still gates while open
PASS  rejected major + closed critical + open minor -> agent_tested  (ck-1-gat: status in_progress → agent_tested)
PASS  review show keeps the rejected finding with verdict + reason  (f-falsemaj major open r1 … no retry on state PUT [rejected by e2e-checker: kv.ts:41 already retries the PUT on 409])
PASS  ledger holds review-checker rows for the verdicts  (2 checker rows)
PASS  disputed still blocks the gate  (boardctl: agent_tested refused: open review findings — 1 critical)
PASS  disputed verdict surfaced as a `proposed:` ledger row for a human  (proposed: disputed review finding f-dis (critical) — race exists on paper, no repro path found)
PASS  review-check with an unknown finding id exits non-zero  (rc=2 boardctl: no finding 'f-nope' on ck-1-gat)
PASS  malformed verdict file: gate fails closed, names the critical  (…; verdicts unreadable (Expecting property name enclosed in double quotes …))
PASS  review-check refuses to append onto a malformed verdict file
PASS  hand-written rejected verdict clears the gate too  (ck-4-han: status in_progress → agent_tested)
```

That last one is the file-contract proof: a `review_verdict.json` written
without `boardctl` (the agent writes the file itself) is honoured
identically — CLI and file paths agree on the contract.

### Real browser page (same suite, own state server :25917 + bundle :25981)

```
PASS  ui: CK1 chip keeps the rejected major in the counts  (r1/3 crit 0 · maj 1 · min 1 · nit 0 · rej 1)
PASS  ui: CK1 chip not tinted as blocked (nothing still gates)
PASS  ui: CK2 chip still tinted blocked (disputed gates)
PASS  ui: CK3 chip still tinted blocked (verdicts unreadable)
PASS  ui: rejected + confirmed verdict badges render  (rej=1 conf=1)
PASS  ui: rejected badge carries the reason + checker name  (e2e-checker: kv.ts:41 already retries the PUT on 409)
PASS  ui: rejected finding row stays visible (history kept)
PASS  ui: CK3 gate note names critical + unreadable verdicts  (open review findings — 1 critical; verdicts unreadable (malformed JSON …))
PASS  ui: CK3 drawer move to agent_tested REFUSED via alert
PASS  ui: proposals list shows the disputed verdict row  (proposed: disputed review finding f-dis (critical) — race exists on paper, no repro path found)
PASS  ui: events list shows the review-checker rows  (3)
PASS  ui: zero pageerror events
```

Full suite: **39/39 assertions passed**
(`~/.hermes/tools-venv/bin/python scripts/e2e_review_checker.py`).

### Adjacent suites

- `scripts/e2e_review.py` — **50/50** (gate semantics, drawer, chips
  untouched for cards without verdicts).
- `scripts/e2e_pm.py` — **68/68** (LinksTab proposals filter widened — pm's
  `proposed:`/`applied:` rows still feed their lists).
- `scripts/e2e_all.py` — 20/21 suites green including the new
  "review checker" entry. The one failure is **pre-existing and unrelated**:
  `e2e_dash_math.py`'s "day table lists only buckets with data" expects the
  two seeded days to share one 7-day bucket, but `bucketizeDays` anchors
  buckets at the epoch and yesterday (2026-09-24 = epoch-day 20720,
  `mod 7 = 0`) is a bucket boundary — the assertion fails whenever the suite
  runs on a Friday. The dashboard code path is untouched by this diff
  (verified: `git diff` shows no dashboard/usage files).

## Hard rules kept

- `server/acp-runner.mjs`, the roles store's model choice, and other cards'
  critical paths: untouched (`git diff --stat` shows only the files above).
- The gate still refuses on confirmed critical/major — `confirmed`,
  `disputed` and unvetted findings all still count; only `rejected` clears.
- No card-field changes; verdicts live in `.acp/cards/<id>/` like findings.
- No new dependencies (`package.json` untouched).

## Not verified live

- An actual review-checker agent run (the role prompt driving a real model
  end-to-end) — the file contract, both writers, the gate, and every UI
  surface are E2E-covered; the model-facing prompt is verified by review,
  not by a live agent session.
- `review-check` on a card whose project is NOT in the registry and whose
  artifacts are not under cwd — the `--project-path` flag covers it but the
  suite always resolves through cwd/registry (same resolution findings use).
