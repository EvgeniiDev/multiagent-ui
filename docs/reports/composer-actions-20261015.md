# Composer controls and graphite recovery — 15 October 2026

Stop is an icon-only square button beside Send, rather than an action above the
field. Voice input and the model/mode pickers remain available during a running
reply. Connection and speech-service availability checks still apply. On narrow
screens, the context meter moves into the live status row during a reply so the
bottom row fits Stop, Send and a voice timer together.

## Theme regression and recovery

A previous frontend rebuild restored the older warm palette because the source
tokens differed from the actual deployed stylesheet. The earlier browser checks
exercised both browser color preferences but did not assert the established
palette. The user caught this regression.

The exact original deployed `:root` block was recovered from the saved stylesheet
and immediately appended to the live CSS without replacing JavaScript. Its
variables were also restored in `src/styles/tokens.css`, then included in the
final committed build. Graphite uses `#202020` for the main background, `#171717`
for the sidebar and `#dedede` for the primary action. The original 204px sidebar
token was preserved as well. Browser regressions now assert these colors under
both light and dark browser preferences, rather than checking theme switching
alone.

## Commits and deployment

- `f16cef9` — preserve the deployed graphite palette.
- `3a1a561` — native mobile scrolling, fixed composer/navigation, inline recording
  and progress, Stop beside Send, voice and settings available during replies.

Frontend release sources were compared byte for byte against commit
`3a1a561fac3cd60af5769ada2d24750d68adb512`. Unrelated working changes, including telemetry removal in App.vue,
were excluded from both the commit and release. The isolated release tree kept
complete source files and had its own dependencies. `npm run build:web` passed,
including vue-tsc; Vite reported the existing chunk-size advisory.

Web mount: `/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`.
Unchanged web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Older assets were preserved; index.html was replaced last. Served index and
entry asset bytes matched the final build. No service lifecycle operations were
performed.

- `/assets/index-BKxpgEJx.js` — SHA-256 `2c21fd7b483db1fe896c2335769cc1d959e258bd70e3fa09521944f30a5ea335`.
- `/assets/index-ohB_upOK.css` — SHA-256 `4efa69c2707ed3a5de71414ca295a2bbea31ca38d02c867747fcd5b5af8f4965`.

## Verification

- Sixteen send, dictation and drawer regressions passed, including dictation
  finalized during an existing turn being sent through the follow-up path.
- The final candidate and deployed browser suite covered 320/390/430/780px and
  1440px desktop, retaining navigation/history/follow/viewport checks from the
  preceding release. Busy-state tests changed model and mode through the real
  pickers, recorded and finalized audio with Chromium's fake microphone and a
  mocked transcription endpoint, checked that model work continued, and verified
  one Stop cancellation request while preserving the next draft. All ACP/state
  traffic in these action tests was mocked; no real model was prompted.
- Stop geometry, keyboard focus, icon-only labeling and adjacency to Send were
  checked. Graphite colors were checked in the final assets at mobile/desktop
  sizes with both browser color preferences. Reading existing history, native
  touch scrolling and reload were checked separately against the real backend,
  with model prompts and cancellation prohibited. Expected state CAS conflicts
  are accepted only after a successful subsequent PUT.
- Scoped manual diff review and CRLF-aware whitespace checks passed. Original
  tests failed on the status-row Stop before the correction. A later test setup
  assumed a nonzero document position after microphone focus; it was corrected
  to establish that position before checking the older-history trigger.

Evidence: `.agent-tmp/composer-actions-release/` contains recovery metadata,
source/build/browser logs, deployment hashes and the real backend read results.
The existing `.agent-tmp/mobile-browser-voice-release/release-source/` directory
was reused as the isolated build tree. Actual hardware microphone behavior and
physical address-bar animation were not tested. Open pages need a reload.
