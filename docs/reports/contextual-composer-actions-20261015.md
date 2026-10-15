# Contextual composer actions — 15 October 2026

The user asked to combine Send, voice recording, generation Stop and recording
Stop because the composer showed too many independent controls.

Voice already toggled between recording and recording Stop. The toolbar now
groups it beside a contextual primary action. With an empty draft while the
model is responding, the primary Send control becomes generation Stop. A prepared
follow-up or active dictation retains Send plus a separate generation Stop, since
sending and cancelling remain independent actions in that state. Ordinary states
have two controls; the concurrent follow-up state has three. Recording remains
available during generation. Recording Stop retains the transcript; Send during
recording finishes recognition before submitting it.

The primary control now uses UiButton and existing theme variants. Parent scoped
Send appearance rules were removed; the page owns only layout. Labels/tooltips
distinguish generation Stop from recording Stop. No theme tokens, fullscreen,
audio segmentation, bridge or recognizer code changed.

Implementation `8d62b2bc6b0dd0434842012ba94784263e2eef4f` on
`feature/pi-session-image-cleanup`. Other worktree changes were excluded.
The isolated vue-tsc/Vite build passed with the existing chunk-size advisory,
and compiled frontend inputs matched committed sources byte for byte. Scoped
manual review and CRLF-aware diff checks passed.

## Checks

- Thirty existing STT/send/draft tests passed.
- `scripts/test_composer_actions_browser.cjs` initially failed on the old grouped
  control contract, then passed at 320/390/1440px. It checks idle/disabled Send,
  draft Send, generation Stop reusing the primary slot, independent Stop for a
  prepared follow-up, microphone availability, recording Stop, preserved drafts,
  mocked cancel/send RPC counts, keyboard focus, 44px mobile targets, no horizontal
  overflow and graphite enabled/hover colors under both browser color schemes.
- `scripts/test_voice_stream_browser.cjs` passed against the candidate, retaining
  pre-Stop progress, manual edits, final insertion and failed-dictation Send guard.
  These action tests mock ACP/state/STT and use real browser audio capture with
  a synthetic Russian speech WAV; no real model work is launched.
- Rendered mobile and desktop screenshots were inspected; theme/controls use
  shared primitives. A test-only hover assertion initially retained the previous
  loop's pointer position; moving the pointer away before each resting-color
  measurement resolved it, with no product changes.

## Publication

Verified web mount `/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`.
Old hashed assets retained; index.html replaced last. Served index and entry asset
bytes match the build. Unchanged web image:
`sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
No service or bridge lifecycle actions were performed.

- `/assets/index-DvdFx5dW.js` — SHA-256 `017eba82fddf9e2262cac6ec7469db0f2d122d97d9e15249fd47ed5b00dea6f5`.
- `/assets/index-DIvnhjUO.css` — SHA-256 `97d0c778a3cb1723ee0a013025dca5db02d6311c52fa1492887a1401545d1e63`.

The published-assets action suite also passed all three widths with no page
errors. The published voice suite passed at 390/1440px using the actual HTTPS
OpenAPI/transcription service, fake microphone speech and mocked ACP/state.
Transcription requests were HTTP 200, pre-Stop text and edits survived, and no
voice error remained after success. This verifies the recognizer integration,
not a real model prompt or a physical microphone recording.

Evidence: `.agent-tmp/composer-actions-release/`. Open pages require reload.
Physical phone interaction is not claimed; browser mobile emulation and injected
microphone audio are the available device-level evidence.
