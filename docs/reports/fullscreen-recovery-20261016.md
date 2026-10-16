# Swipe fullscreen recovery — 16 October 2026

The user clarified that the browser address bar no longer hid, rather than the
in-app session tabs failing to return. The published pre-fix build still entered
fullscreen on a fresh gesture and restored session tabs while fullscreen. Three
subsequent-entry failures were independently reproduced:

1. Any fullscreen exit set a shared opt-out until reload, even an exit not made
   through our control. A second downward gesture then never requested fullscreen.
2. A single rejected automatic request also set that permanent opt-out, so a new
   trusted gesture could not retry a transient denial.
3. Starting the gesture on a button inside a tool card excluded it from entry,
   although dragging that button is a history-scroll gesture rather than a click.

The exact physical-phone sequence that triggered the user's symptom was not
observed. These are confirmed client failures that can keep the address bar
visible; no claim is made that browser chrome itself was measured in emulation.

## Change

Only an explicit Exit in the fullscreen control now opts out. Browser-initiated
exits leave auto entry enabled, and denied automatic requests can retry on a new
trusted gesture. Manual entry re-enables auto behavior. Failed manual actions
retain the previous preference. Errors remain retryable through settings.

Tool-card button drags now qualify, while ordinary taps remain ordinary button
actions. The controlled drag cancels its click default; form fields/selects and
editable text remain excluded. The request still runs on trusted release with
transient activation, never on programmatic scroll or model replay.

Implementation `669985dd7470f5b76772edcca4f66f1c0a99aad3` on
`feature/pi-session-image-cleanup`. Runtime changes are confined to UiFullscreen;
composer controls, voice processing, palette and bridge sources are unchanged.

## Checks

The pre-fix build failed independent external-exit, denial-retry and button-drag
browser checks. `scripts/test_fullscreen_recovery_browser.cjs` passes with the
candidate at 390/780px: actual Chromium fullscreen, no activation supplied by
page evaluation, reentry after external exit, explicit opt-out, manual reenable,
retry after denial, tool-button drag without a click, draft preservation and
visible bottom input. Denials are simulated; fullscreen entry/exit is real.

The 390px navigation suite also passed the candidate with native scrolling,
session tabs, fullscreen entry/exit/fallback, graphite styles, voice/settings,
busy controls and saved positions. Its deliberate-exit test now uses our Exit
control rather than an API-only exit. Two test-setup issues were separated from
product behavior: keyboard focus requires a preceding keyboard interaction, and
the legacy default fake microphone can be silent with VAD. The run used an
explicit synthetic speech WAV via VOICE_WAV and sufficient capture duration.

A candidate check with the real read backend restored existing history in
4,145ms and passed reentry after an API-only exit and visible composer checks.
No prompts or cancellation were permitted. Page errors, HTTP errors, RPC errors
and error banners were empty. This simulates an external fullscreen exit; it does
not claim a real phone keyboard/background transition was exercised.

The isolated vue-tsc/Vite build and scoped diff/manual review passed, with only
existing chunk-size advisories. Compiled inputs matched committed frontend
sources byte for byte; unrelated WIP was excluded.

## Publication

Verified `/home/hermes/projects/acp-ui/dist-web` → `/repo/dist-web`, retained old
hashed assets and replaced index.html last. Served index and entry assets matched
the build. No service or bridge lifecycle changes were made. Unchanged web image:
`sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.

- `/assets/index-BCkzKaS1.js` — SHA-256 `109065a4785fcf5959379a69496e820e14b949732c9c9a2f5e07b27c88dfd4ad`.
- `/assets/index-H3p0wpMq.css` — SHA-256 `ac112232b5a5a7fce88a559fbade355b57977dd38fe2dbec4b4346732abebfa0`.

The published 390px recovery suite passed all new scenarios. The real-read
published check restored history in 4,398ms and passed fullscreen reentry and
composer geometry; page/HTTP/RPC errors and error banners were all empty.

Evidence: `.agent-tmp/fullscreen-recovery-20261016/`. Open tabs need reload.
Physical phone address-bar behavior still requires user confirmation.
