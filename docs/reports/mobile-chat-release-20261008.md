# Mobile chat release — 8 October 2026

Deployed the mobile drawer gesture, removed the empty header/menu row, and
collapsed model/mode/context controls under one settings button. Corrected
compact selector CSS specificity: mobile menus previously rendered entirely
above the viewport. Chat-edge vertical scrolling and horizontal code scrolling
remain native; desktop controls remain inline.

Fixed a send/dictation race: `stop()` only requested the final STT transcript,
so it could arrive after clearing the field and reinsert the text. Send now
waits for the final/fallback transcript, snapshots it, then clears the composer.
Duplicate taps during finalization are ignored. A delayed prompt error cannot
overwrite a newer draft or its attachments. A failed send still restores an
otherwise untouched composer for retry.

Updated AGENTS.md and TESTING.md at the user's explicit instruction: frontend
builds may run inside the agent container. Existing Compose lifecycle rules
remain in effect.

## Build and publication

Source: main, base commit `dc31163094eaa92a846bf4c8f05c3d11e7c14e33`, with the
uncommitted UI changes recorded by SHA-256 in
`.agent-tmp/chat-composer-release/deployed-mobile.json`.
Live checkout: `/home/hermes/projects/acp-ui-lead-integration`, branch
`ship/agent-modes-20261003`, same base commit; affected source files synchronized.
Build: `npm run build:web -- --outDir .agent-tmp/chat-composer-release/dist-web`
in the agent container, including vue-tsc. Existing Vite chunk-size advisory.

Verified web container mount: live checkout `dist-web` → `/repo/dist-web`.
Published through the already-running bridge's writable project mount using
the newly forwarded Docker socket. Preserved old hashed assets and atomically
replaced index.html last. No service restart or image rebuild was required.
Verified HTTPS index/assets against the build bytes at
`https://192.168.1.222:25809`.

- JavaScript: `index-Ck5v-CJ8.js`, SHA-256
  `83b8fa3fb0dce28abc67491e2141326b50d7952fb43a287c709994396c0b51ac`.
- CSS: `index-D7Lui25J.css`, SHA-256
  `657df1c5fd9028ed94ad7dbc5c13a9f0a823338a84d6388efa7fd5683d856e7d`.

## Verification

- Six gesture unit checks and four send regression checks passed. Original
  send implementation failed the late-voice-final and newer-draft regressions.
- Actual deployed frontend + real read backend, Chromium native touch:
  drawer opens/closes, settings/model/mode menus open and fit, current options
  are selectable without changing the user's model, 44px single-row toolbar,
  matching feed/composer width, 320/390/780 light and dark layouts, 430px short
  viewport, reload, keyboard focus/Escape, and desktop layout at 1440px.
- No page errors or JSON-RPC errors. Activity journal PUT409 CAS conflicts were
  followed by PUT200 recovery; no other HTTP failures.
- Deployed send UI with send/steer dispatch stubs: typed input clears immediately,
  and a simulated late turn failure preserves a newer draft. Live model prompts
  were explicitly blocked. No model work was launched for verification.
- Voice finalization was verified using the real handlers/method with delayed
  transcript callbacks; microphone/STT hardware was not exercised in this run.

Detailed browser evidence and scripts live in
`.agent-tmp/chat-composer-release/`; `deployed-mobile.png` is a deployed screenshot.
Existing pages need a reload to receive the new assets.
