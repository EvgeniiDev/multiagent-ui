# Fullscreen after a downward swipe — 15 October 2026

The user confirmed explicit fullscreen worked and requested entry without opening
settings. On mobile browser chat, a trusted upward finger swipe (toward newer
messages) of at least 32 CSS pixels now requests fullscreen when the gesture ends.
The whole document remains the fullscreen target, preserving the bottom composer.

Only gestures starting in the active transcript qualify. Horizontal, multitouch,
cancelled and synthetic gestures are ignored, as are replay, streaming and
programmatic scrolling. Desktop, Tauri and standalone Home Screen behavior is
unchanged. A manual or browser-initiated exit disables automatic reentry across
session tabs until reload. A rejected automatic request also stops retries;
manual entry and its retryable error remain available in chat settings.

This is conditional on browser fullscreen support and transient user activation.
No scroll handler can manufacture that permission. A fresh mobile Chromium
context accepted the real native touch sequence; physical phone behavior remains
unverified. Unsupported iPhone guidance remains available.

## Verification and publication

Implementation: `9474e9096f37bbd5e58ab35f086034d0cc4c5fd0` on
`feature/pi-session-image-cleanup`. The regression initially failed on the
published old version because downward scrolling never entered fullscreen.
The isolated build passed vue-tsc and Vite, with only existing chunk advisories.
Compiled input was compared byte for byte with committed sources; unrelated
working changes were excluded. Scoped manual review and diff checks passed.

The candidate browser suite passed at 320/390/430/780/1440px. It used trusted CDP
touch input and actual Chromium fullscreen, checking downward entry, no upward or
programmatic entry, draft preservation, visible composer and no reentry after
exit. Existing manual entry/denial/retry, keyboard focus, themes, unsupported
capability, busy voice/settings/Stop and navigation checks also passed. These
checks mocked ACP/state/transcription and used fake microphone input.

Publication verified the existing web bind mount
`/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`, retained old assets and
replaced index.html last. No service or bridge was restarted. The web image
remained `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

- `/assets/index-D_QpSL95.js` — SHA-256 `94f90f1f4622bb1105161999f2c9744a3670364655ba842349914f67abb6f9a2`.
- `/assets/index-C4ery_HD.css` — SHA-256 `353edfb231ed3edaaea426bfbfaeb43937942d42c436f22f91eb2e467cea26a3`.

The same action suite passed against the published assets. A separate real
backend read-only run restored existing history in 6,384 ms and passed automatic
entry, visible input, exit suppression, manual entry/exit, native scrolling,
themes, short viewport, desktop and reload. It sent no model prompts/cancels.
Page errors, JSON-RPC errors and error banners were empty. One activity-state
HTTP 409 recovered with subsequent successful PUTs. The live probe initially
tapped settings during post-swipe/fullscreen settling; waiting 500 ms before the
next tap allowed the native gesture to settle and the check passed.

Evidence: `.agent-tmp/fullscreen-auto-release/`. Fullscreen may still require the
manual control in browsers that withhold activation after a swipe.
