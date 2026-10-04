# Managed state timeout during Pi history restore, 2026-10-04

The repeated 8000 ms body timeout was reproduced in actual Chromium on
`/board?s=Pi%3A%3A01a0de3a-52b6-7052-8a79-dcd57bb84701` while opening the existing
Reddit card `962d16ed-be41-4c0a-857f-7d1481d9141a`. Eight serial reads spaced by
one second were enough: one got headers after 4556 ms and its body aborted at
12782 ms. A CPU profile recorded 619 long tasks totaling 46.676 seconds over about
54 seconds, mainly filtering the deep reactive activity ledger per board card.

Every historical tool_call/session_info_update streamed by session/load was
being logged as fresh activity with a new ID and current timestamp. Each
append invalidated card computations, which each scanned up to 5000 rows.
This saturated the browser thread and delayed response-body processing and
abort timers. Repeated activity persistence also loaded the state write queue.
Plain warm `/board` without the explicit Pi restore completed 24 parallel reads
in 2.928 seconds with negligible header-to-body delay. Correct Content-Length
was verified. Earlier overlapping browser stress measurements were confounded
and were not used to establish this causal chain.

The runtime now guards the complete session/load interval, including first
loads without cache and authentication retries. Historical frames still build
the transcript and update tool status; they do not become fresh tool-call or
session-info activity. The guard clears in finally, including failed loads,
and subsequent live events are recorded. Existing activity is preserved.

Activity rows now publish immutable shallow snapshots. One shared index by
session ID/title serves board cards instead of repeated full reactive scans.
The existing claim/session precedence, legacy title fallback, terminal run
facts, delegate outcomes and 5000-entry rollover are preserved. Timeouts and
HTTP transport were not changed; no backend/bridge restart was needed.

Validation on the final host-built production frontend `index-ElzU_35Y.js`:

- 13 targeted tests pass: six replay cases, bridge error/resume, three activity
  index cases and three board-loading cases. Replay tests failed before the
  fix; tests cover cached/first/repeated/async restores, failure and auth retry,
  and live activity after restore. Index tests cover facts, remote snapshots,
  rollover and many card/clock lookups without rescanning 5000 rows.
- All 76 execution UI/API/store tests pass. Host build and diff checks pass.
- Real Chromium used the exact Pi URL, opened the existing Reddit card and
  performed eight serial GET/body reads during restore. Maximum whole-read
  time 337.6 ms; maximum post-header read 68.5 ms. One long task 77 ms total.
- Actual selected session/load RPC succeeded in 0.497 seconds; after reload it
  succeeded in 0.437 seconds. Managed panel stayed online without errors after
  both loads. No failed HTTP requests or JavaScript page errors.

Private evidence: `.agent-tmp/autonomous/browser-production/`
`pi-board-timeout-profile.json` (before), `pi-board-timeout-final.json` (after).
The testing rules now explicitly require the combined large-session restore
and managed-card path when these areas change; fast curl alone is insufficient.
