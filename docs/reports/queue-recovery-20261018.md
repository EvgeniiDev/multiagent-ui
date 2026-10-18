# Queue delivery recovery — 2026-10-18

Source commit: `2888fe2c1ac5e89584b4afb918dc5bc794f208f5` (main).

## Problem and fix

A socket close could reject the prompt response after the agent had already
accepted the message. The outbox restored the message as failed and paused,
even when the remote transcript contained its delivered user turn. Separately,
a restored runtime without a local prompt promise could send Queue during a
remote turn, making it act like concurrent steering.

Text-only failed Queue deliveries now carry a user-turn ordinal and reconcile
against successful remote history replay. Legacy entries use an unambiguous
cached ordinal. Matching earlier arbitrary text, unsent entries, attachments,
and Steer are never treated as delivery proof. An acknowledged message is
removed without resending it.

Queue observes remote work after lost prompt ownership, live activity, saved
working state, or delivery reconciliation. Only a provider terminal result
from a read started after that observation releases the remote-work latch.
Tool completion does not release Queue. Explicit Steer retains its tool-boundary
behavior. Concurrent status refreshes share one request.

## Evidence

- Before fix: four failing regressions, `/tmp/acp-queue-red.log`.
- Final unit/runtime/status checks: 40 passed, `/tmp/acp-queue-unit-final3.log`.
- `npm run build:web`: UI policy, typecheck, Vite passed;
  `/tmp/acp-queue-build-release.log`. Existing bundle-size warning remains.
- Browser fixtures on the candidate: native Queue/Steer/FIFO/files/error/reload
  at 390 and 1920 px; recovery at 390 and 1440 px. Earlier provider-profile
  checks also passed for Hermes and OpenCode.
- Deployed frontend with protocol/API fixtures: accepted-send/socket-drop/replay,
  no duplicate prompt, remote tool boundary, fresh terminal release, legacy
  recovery and reload while still working passed at 390 and 1440 px;
  `/tmp/acp-queue-browser-prod.log`.
- Real Codex backend, read-only inactive session: two actual history loads,
  removal of a seeded legacy failed entry whose user turn was present,
  zero model prompts and zero page errors; `/tmp/acp-queue-real-prod.log`.
- Two distinct real sessions, the same sessions in another window, and socket
  recovery: five successful loads, no errors; `/tmp/acp-queue-parallel-prod.log`.
- Real long history and managed board card, with delayed load acknowledgements:
  open and reload passed, two history loads, 24 execution GETs returned 200,
  no page errors; `/tmp/acp-queue-board-prod.log`.

Synthetic delivery tests use fixtures; real backend checks only read history
and card state. No paid model turns or user-card work were started. An initial
candidate QA navigation raced the build; rerunning after build completion
passed. This was test setup, not a product failure.

## Deployment

Frontend only; no bridge, agent process, or service restart.
Actual inspected web mount: `/home/hermes/projects/acp-ui/dist-web`.
Web image unchanged: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Older hashed assets retained; index replaced last.
HTTPS responses on `https://192.168.1.222:25809` match local SHA-256:

- index: `e236166af95105ceb058c16a475c18a9eef368467770f07d1933494f816f6f7e`
- JS: `/assets/index-Cizyz1G3.js`, SHA-256
  `de0f824c696c2e6d5a447a1a2e9b2b9ba7aa1c6cb4d49c7f8886f5cd34764d8b`
- CSS: `/assets/index-DiRTSZLC.css`, SHA-256
  `90d7f749a8a36cd386a703d4faafd0d9235ae0468fece626373d98fcc2da17c6`

Index revalidates (`no-cache`); hashed assets are immutable. Open tabs need a
page reload to receive this runtime. Release metadata: `/tmp/acp-queue-release.json`.

## Limits

Ambiguous attachments and Steer deliveries stay paused for manual handling;
they are not automatically retried. If provider lifecycle evidence is unavailable,
observed remote work remains busy rather than guessing completion. Native
lifecycle polling can delay release by its existing five-second interval.
An otherwise unknown resumed turn without work metadata or live events is not
proved busy by this change. No backend lifecycle behavior was changed.
