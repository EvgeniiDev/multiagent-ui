# Continue preparation after an answer — 2026-10-04

The Reddit session saved the user's answer, then the lead repeated the already
answered question. Deduplication correctly rejected the repeat but completed
the attempt with no progress. With no running attempt, the runner became idle.
The earlier browser verification stopped at answer persistence and missed this
failure to continue.

The continuing prompt now explicitly asks the lead to use the recorded answer
for its next unresolved question or a proposal for explicit confirmation. A
result containing only deduplicated questions now atomically creates a
corrective turn in the same discussion. Existing no-progress limits stop
repeated failures; native dialog routing and genuine completed results retain
their behavior.

The discussion UI collapses documents, gates, bindings and handoff settings
during Q&A. Those controls expand when a proposal/document is ready for review
and no question is pending. Diagnostics remain separately collapsed.

## Verification and recovery

- Two backend regressions reproduced idle after a repeated answered question;
  both now pass, including the bounded recovery case.
- Preparation lead/state: 39 passed; runner/result fences/handoff: 27 passed.
- Preparation UI: 28 passed. Host frontend build and Python harness syntax
  checks passed. Final served asset: `index-ixs19u5x.js`.
- Actual Chromium + production backend/provider on an isolated QA card:
  fresh session -> question -> answer through the panel -> a different next
  question without a user nudge -> persisted on reload. Controls were
  collapsed; no browser errors or implementation run. QA discussion stopped.
- Real Reddit card: resumed its existing idle discussion with the saved answer
  through `continue_discussion`, without inventing an answer or approval. The
  lead now asks what “all comments” means and what stops loading. Read-only
  browser checks confirmed the discussion is visible and controls collapsed.
- Updated TESTING.md: answer persistence alone is insufficient; wait for a
  substantive next turn and distinguish fresh sessions from stopped ones.

Local proof: `.agent-tmp/autonomous/browser-production/prep-two-turns-proof.json`
and `check_prep_two_turns.py`. The first harness attempt accidentally read an
open question from the previous stopped QA session; corrected its session/status
guard before the successful fresh-session verification.

Deployed from `ship/agent-modes-20261003` through the existing source/frontend
mounts. State and runner restarted after tests; bridges unchanged. Existing
browser tabs need reload.
