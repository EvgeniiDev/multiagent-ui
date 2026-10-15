# Mobile fullscreen — 15 October 2026

The user reported that native page scrolling still did not collapse the phone's
address bar. That browser-chrome behavior could not be reproduced in desktop
emulation. This release provides the requested alternative: an explicit
Fullscreen action in the composer's settings. It does not claim to fix automatic
address-bar collapse on the user's device.

`requestFullscreen({ navigationUI: 'hide' })` targets the document element, so
history, bottom input, dialogs and settings all remain in the fullscreen tree.
The control tracks browser-initiated exit, exposes a retryable rejection message,
and remains available after a wide viewport/orientation change. Normal desktop
layout hides the control until fullscreen is active. Existing Tauri hosts do not
use the feature. No fullscreen state is falsely persisted across reloads.

Unsupported iPhones receive Share → Add to Home Screen instructions. Apple
standalone/status-bar metadata is included, and a Home Screen launch hides the
redundant fullscreen action. This fallback was verified as a simulated capability
and launch-state contract, not as a physical iPhone installation. References:
[Fullscreen user activation and events](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen),
[Apple standalone web applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html).

## Build and publication

Implementation commit: `e423ad0b5400e646871c88ad55a4fa1917493b26` on `feature/pi-session-image-cleanup`. The isolated release sources were
compared byte for byte with committed frontend sources, excluding unrelated WIP
in index.html and other files. `npm run build:web` passed with vue-tsc and the
existing chunk-size advisory. Graphite tokens remained unchanged.

Verified mount: `/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`.
Unchanged web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Older hashed assets were retained; index.html was replaced last. Served index
and entry assets matched the build bytes. No service lifecycle action was needed.

- `/assets/index-DOz2tnDd.js` — SHA-256 `b8072d6303969e177a04694c7d4d423f8bc70f86bf24d5696da862ed74923f8c`.
- `/assets/index-DYwnuwmn.css` — SHA-256 `316b03634004ea3a839781bfd0ff1fcaaecb0072d6e877beae47d475fd56663a`.

## Verification

- Sixteen existing send/dictation/drawer unit regressions passed.
- The candidate and published browser suite exercised actual Chromium fullscreen
  entry and exit at 320/390/430/780px, with scrolling, draft preservation, visible
  bottom input, external exit synchronization and a wide layout. A rejected
  request was simulated, followed by a successful real retry. Unsupported
  capability and iPhone Home Screen state were simulated. Focus/touch geometry,
  graphite colors and previous composer/navigation flows were also checked;
  desktop at 1440px retained its normal layout. These action tests mocked ACP,
  state and transcription, with fake microphone input and no real model calls.
- A separate published-assets check used the real read backend and actual
  fullscreen entry/exit, with model prompts/cancellation prohibited. Existing
  history restoration, native scrolling, the visible composer, themes, short
  viewport, desktop transition and reload were checked. Page errors, HTTP,
  JSON-RPC and visible error banners were monitored. State CAS conflicts require
  a later successful PUT before being accepted.
- Scoped manual review and CRLF-aware diff checks passed. Browser fullscreenchange
  rendering was awaited explicitly; viewport rotation was emulated through CDP
  rather than attempting to resize an OS fullscreen window.

Evidence: `.agent-tmp/fullscreen-release/`. Physical phone browser chrome and
soft keyboard behavior still need device confirmation. After reload, the user
must tap Chat settings → Fullscreen; the browser requires a user gesture.
