# Create a new session during an answer — 8 October 2026

The sidebar plus used anySessionBusy, defined as any tab being isLoading or
isConnecting. isLoading includes ordinary prompt execution, so an answer in
any tab disabled new-session creation even though each new session already
gets an independent runtime/connection.

The gate is now anySessionConnecting: initial connection still disables repeat
clicks, ordinary answers/history loading do not. The plus uses shared UiButton
with an accessible busy state, focus styles and a 44px mobile touch target.
No runtime, bridge, prompt or cancellation behavior was changed.

Three regression tests in scripts/test_new_session_gate.mjs failed before the
fix and pass afterward, covering an answering tab, connecting-to-answering
transition and a failed background connection. Type checking and the web build
passed; existing Vite chunk-size advisory remains.

Preview browser checked the new gate and light/dark focus/hover/touch styles.
Actual deployed mobile browser then created a real empty Codex session through
session/new with the original tab's isLoading UI flag set to true. Its reply
was delayed one second; repeated clicks produced exactly one new session.
The old runtime stayed open/loading, with no close, cancel or prompt calls.
Desktop availability was checked too. No paid model work was started. The
running answer was represented by a UI flag, not a live test model turn.
Empty QA sessions were labelled and their tabs closed after checking.

The latest acceptance had no page or RPC errors. One activity journal PUT409
was followed by PUT200 recovery. An earlier pass succeeded on the functional
checks but failed the HTTP assertion without recording the individual response;
the repeat captured all observed HTTP statuses and passed.

Built inside the agent container using
`npm run build:web -- --outDir .agent-tmp/new-session-release/dist-web`.
Published to the existing live web mount, preserving hashed assets and replacing
index last; no services restarted. Actual HTTPS bytes matched the staged build.

Source: main at base 8b3cd524671e0db094c5fa84c4a5abfb9dbd9a2f plus the two
uncommitted source changes and regression test. Live checkout:
/home/hermes/projects/acp-ui-lead-integration on ship/agent-modes-20261003.
Affected sources and the test were synchronized. Deployment metadata records
running container/image IDs, mounts and dirty-source hashes.

- JavaScript index-DYNb95eJ.js, SHA-256
  c111b88c81c7b98bc8c60aab828699bfd40a6192ba8089f207cb1d703e40984e.
- CSS index-C_uS29VY.css, SHA-256
  a036783edce0a584cacbc3d05937b80a0f5629fc4734653a2a823a902e178210.

Evidence: .agent-tmp/new-session-release/{deployment,browser-evidence}.json.
Existing pages need a reload to receive the new gate.
