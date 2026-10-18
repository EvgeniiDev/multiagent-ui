# Pi startup greeting falsely held the first message in Queue — 2026-10-18

Pi ACP 0.0.33 / Pi 0.85.1 emits startup information as an
`agent_message_chunk` immediately after `session/new`. The runtime inferred a
remote turn from that unsolicited assistant text, recorded `output`/`working`,
and waited for a terminal result. No prompt existed to produce that result,
so the first composer message remained queued indefinitely.

The runtime now keeps assistant-only startup text visible without treating it
as work before a user turn exists. Reopening a complete banner-only transcript
clears the old synthetic busy status unless provider evidence independently
reports ongoing work. Replay and locally owned prompts skip the startup scan.

## Validation

- Before: new-session ACP wire probe observed a startup assistant chunk without
  any prompt; actual deployed frontend browser regression failed with
  `working !== null` after this greeting.
- Four runtime regressions cover new sessions, late greetings after restore,
  recovery of a saved false status, and preserving provider-confirmed work.
  New/late/recovery tests failed before their corresponding fixes.
- 45 focused Node tests passed for runtime replay, status and outbox; the
  existing runner lifecycle extension checks also passed in that invocation.
- `npm run build:web` passed shared UI policy, TypeScript, production build.
  `git diff --check` passed. Targeted manual review covered fix-owned files;
  no unrelated working tree changes were included. No abstraction or cleanup
  pass was needed for the 16-line implementation change.
- Actual deployed frontend: ACP fixture browser checks passed at 390/1440px,
  including creation through navigation, greeting idle, first Queue delivery,
  completion, reload without resend, no pageerrors or failed HTTP responses.
- Actual deployed frontend with real Pi bridge: creation through navigation,
  greeting idle, exactly one first `session/prompt`, and empty outbox passed
  at 390/1440px. Own test prompts were cancelled. Browser state writes were
  isolated in fixtures so no user inventory was changed.

## Limits and diagnostic observations

A live model response did not complete within 60 seconds, including a retry
with thinking disabled in a separate test session. The runtime stayed
connected with a real prompt in flight and no queued messages or error.
This proves the initial Queue deadlock is fixed; it does not prove full model
response health. A separate direct Pi RPC probe accepted a prompt and emitted
agent/turn/message lifecycle events but produced no text before its 25-second
abort. Cause of this additional response delay remains unconfirmed.

The older broad `test_prompt_outbox_browser.cjs` harness timed out before its
sessions connected: its offline/local session fixture predates the new server
session directory. Its browser result is not counted as passing. Runtime
outbox coverage and the new server-state-aware browser regression passed.

## Deployment

Code commit: `5fc6684b7b4a8a443c100eff1c333bd7c88a3cee` on `main`. Built in `/tmp/acp-pi-idle-fix`.

Published to the inspected live mount `/home/hermes/projects/acp-ui/dist-web`, keeping older hashed
assets and replacing index.html last. Web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

Verified HTTP200 and exact SHA256 on `https://192.168.1.222:25809`:

- `/assets/index-TU70YzFY.js` — `ca752e496a67a220cacb99d3f063ea3d7bb488a9853918af99fcacda8d0e5463`
- `/assets/index-CYqamJ2w.css` — `00f38ccf5a1bd6a501043fef19a7069ccbeca8930a25625858a9e39011dd557c`

No services or bridges restarted; all five bridge PIDs remained unchanged.
Reload the panel once to load the fix. An existing restored queue stays paused
until explicitly resumed, preserving its normal protection against resending.
